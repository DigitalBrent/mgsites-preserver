'use strict';

// Allow HTTPS requests to sites with self-signed / misconfigured SSL certs.
// This is critical: many preserved sites (mgsites.net, etc.) have broken SSL
// and asset downloads will silently fail without this.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Prevent unhandled errors from crashing the server — set up FIRST
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

console.log('Starting server...');

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const { createPreserver } = require('./src/index');

console.log('Modules loaded OK');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_CRAWL_TIME = 10 * 60 * 1000; // 10 minutes max per crawl

// Explicit health check — doesn't depend on static files
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Job store
const jobs = new Map();
let activeJobId = null;

// POST /api/preserve — start a new crawl job
app.post('/api/preserve', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL
  let validUrl;
  try {
    validUrl = new URL(url.startsWith('http') ? url : 'https://' + url).href;
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // One-at-a-time enforcement
  if (activeJobId && jobs.get(activeJobId)?.status === 'running') {
    return res
      .status(409)
      .json({ error: 'A crawl is already in progress. Please wait.' });
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(os.tmpdir(), `mgsites-${jobId}`);
  const outputDir = path.join(jobDir, 'output');
  const zipPath = path.join(jobDir, 'archive.zip');

  const job = {
    status: 'running',
    sseClients: [],
    outputDir,
    zipPath,
    url: validUrl,
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);
  activeJobId = jobId;

  // Create crawler with web mode
  const { crawler } = createPreserver(validUrl, {
    output: outputDir,
    mode: 'web',
    js: true,
    ignoreSslErrors: true,
    maxDepth: 10,
    concurrency: 2,
    assetConcurrency: 4,
  });

  const logger = crawler.logger;

  logger.on('phase', (data) => {
    broadcastSSE(job, 'phase', data);
  });

  logger.on('progress', (data) => {
    broadcastSSE(job, 'progress', data);
  });

  // Start crawl asynchronously with timeout protection
  const crawlTimeout = setTimeout(() => {
    if (job.status === 'running') {
      console.error(`Crawl timed out after ${MAX_CRAWL_TIME / 1000}s for ${validUrl}`);
      crawler.shuttingDown = true;
    }
  }, MAX_CRAWL_TIME);

  job.crawlTimeout = crawlTimeout;

  crawler
    .crawl()
    .then(async () => {
      clearTimeout(crawlTimeout);

      // Compression phase
      job.status = 'compressing';
      broadcastSSE(job, 'phase', {
        phase: 'compressing',
        message: 'Compressing archive...',
      });

      try {
        await createZip(outputDir, zipPath);
      } catch (zipErr) {
        throw new Error(`Zip failed: ${zipErr.message}`);
      }

      // Complete
      job.status = 'complete';
      broadcastSSE(job, 'complete', {
        downloadUrl: `/api/download/${jobId}`,
      });
      activeJobId = null;
    })
    .catch((err) => {
      clearTimeout(crawlTimeout);
      console.error(`Crawl error for ${validUrl}:`, err);
      job.status = 'error';
      broadcastSSE(job, 'error', {
        message: err.message || 'Crawl failed',
      });
      activeJobId = null;
      // Don't cleanup immediately — give the SSE time to send the error
      setTimeout(() => cleanupJob(jobId), 10000);
    });

  res.json({ jobId });
});

// GET /api/progress/:jobId — SSE endpoint
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial status
  res.write(
    `event: phase\ndata: ${JSON.stringify({ phase: job.status, message: 'Connected' })}\n\n`
  );

  // If already complete, send immediately
  if (job.status === 'complete') {
    res.write(
      `event: complete\ndata: ${JSON.stringify({ downloadUrl: `/api/download/${req.params.jobId}` })}\n\n`
    );
    res.end();
    return;
  }

  // Register SSE client
  job.sseClients.push(res);

  // SSE keepalive every 15s
  const keepalive = setInterval(() => {
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.write(': keepalive\n\n');
      } else {
        clearInterval(keepalive);
      }
    } catch {
      clearInterval(keepalive);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    if (job.sseClients) {
      job.sseClients = job.sseClients.filter((c) => c !== res);
    }
  });
});

// GET /api/download/:jobId — serve the zip
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'complete') {
    return res.status(404).json({ error: 'Download not available' });
  }

  let hostname = 'site';
  try {
    hostname = new URL(job.url).hostname.replace(/\./g, '-');
  } catch {}

  const filename = `${hostname}-preserved.zip`;

  res.download(job.zipPath, filename, (err) => {
    if (err && !res.headersSent) {
      console.error('Download error:', err);
    }
    // Clean up after download
    setTimeout(() => cleanupJob(req.params.jobId), 5000);
  });
});

// --- Helpers ---

function broadcastSSE(job, eventName, data) {
  if (!job || !job.sseClients || job.sseClients.length === 0) return;
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  const stillConnected = [];
  for (const client of job.sseClients) {
    try {
      if (!client.writableEnded && !client.destroyed) {
        client.write(message);
        stillConnected.push(client);
      }
    } catch {
      // Client disconnected — drop it
    }
  }
  job.sseClients = stillConnected;
}

function createZip(sourceDir, destPath) {
  return new Promise((resolve, reject) => {
    // Ensure the parent dir exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Clear crawl timeout if it's still pending
  if (job.crawlTimeout) {
    clearTimeout(job.crawlTimeout);
    job.crawlTimeout = null;
  }

  // Close any remaining SSE clients
  if (job.sseClients) {
    for (const client of job.sseClients) {
      try {
        if (!client.writableEnded && !client.destroyed) {
          client.end();
        }
      } catch {}
    }
    job.sseClients = [];
  }

  const jobDir = path.dirname(job.outputDir);
  fs.rm(jobDir, { recursive: true, force: true }, (err) => {
    if (err) console.error('Cleanup error:', err);
  });

  jobs.delete(jobId);
  if (activeJobId === jobId) activeJobId = null;
}

// Stale job reaper — every 30 minutes, clean up jobs older than 1 hour
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (job.createdAt && now - job.createdAt > 60 * 60 * 1000) {
      cleanupJob(jobId);
    }
  }
}, 30 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MGSites Preserver running on port ${PORT}`);
});
