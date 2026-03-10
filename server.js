'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const { createPreserver } = require('./src/index');

const app = express();
const PORT = process.env.PORT || 3000;

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

  const jobId = uuidv4();
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

  // Start crawl asynchronously
  crawler
    .crawl()
    .then(async () => {
      // Compression phase
      job.status = 'compressing';
      broadcastSSE(job, 'phase', {
        phase: 'compressing',
        message: 'Compressing archive...',
      });

      await createZip(outputDir, zipPath);

      // Complete
      job.status = 'complete';
      broadcastSSE(job, 'complete', {
        downloadUrl: `/api/download/${jobId}`,
      });
      activeJobId = null;
    })
    .catch((err) => {
      job.status = 'error';
      broadcastSSE(job, 'error', {
        message: err.message || 'Crawl failed',
      });
      activeJobId = null;
      cleanupJob(jobId);
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
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    job.sseClients = job.sseClients.filter((c) => c !== res);
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
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  job.sseClients.forEach((client) => {
    try {
      client.write(message);
    } catch {
      // Client may have disconnected
    }
  });
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

app.listen(PORT, () => {
  console.log(`MGSites Preserver running at http://localhost:${PORT}`);
});
