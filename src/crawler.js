'use strict';

const PQueue = require('p-queue').default;
const path = require('path');
const {
  normalizeUrl,
  isSameOrigin,
  urlToLocalPath,
  matchesExcludePattern,
  isCrawlableUrl,
} = require('./url-utils');
const { rewriteHtml } = require('./rewriter');
const PageProcessor = require('./page-processor');
const AssetDownloader = require('./asset-downloader');
const Storage = require('./storage');
const Robots = require('./robots');
const Logger = require('./logger');

class Crawler {
  constructor(config) {
    this.config = config;
    this.crawlQueue = []; // Array<{ url, depth }>
    this.visitedUrls = new Set();
    this.assetManifest = new Map(); // url -> { localPath, contentHash }
    this.failedUrls = new Map(); // url -> { attempts, reason }
    this.shuttingDown = false;

    this.storage = new Storage(config.output);
    this.logger = new Logger(config);
    this.robots = new Robots();
    this.pageProcessor = new PageProcessor(config);
    this.assetDownloader = new AssetDownloader(
      config,
      this.storage,
      this.assetManifest,
      this.logger
    );

    // Track saved pages for deferred HTML rewriting
    this.savedPages = []; // Array<{ url, localPath }>

    this.pageQueue = new PQueue({
      concurrency: config.concurrency,
      interval: config.delay,
      intervalCap: 1,
    });

    this.assetQueue = new PQueue({
      concurrency: config.assetConcurrency,
    });
  }

  async crawl() {
    const seedUrl = this.config.seedUrl;

    // Register signal handlers for graceful shutdown (CLI mode only)
    const shutdown = () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      this.logger.warn('Shutting down gracefully... finishing in-flight pages.');
      this.crawlQueue = [];
      this.pageQueue.clear();
      this.assetQueue.clear();
    };
    if (this.config.mode !== 'web') {
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }

    try {
      // Initialize
      await this.storage.init();
      if (this.config.js) {
        await this.pageProcessor.init();
      }

      // Optionally fetch robots.txt
      if (this.config.respectRobots) {
        await this.robots.fetch(seedUrl);
        this.logger.info('Fetched robots.txt');
      }

      this.logger.info(`Starting crawl of ${seedUrl}`);
      this.logger.info(`Output: ${this.config.output}`);
      this.logger.info(`Max depth: ${this.config.maxDepth}`);
      this.logger.startProgress();
      this.logger.phase('crawling', 'Crawling pages...');

      // Seed the queue
      this._enqueue(seedUrl, 0);

      // Main crawl loop: drain crawlQueue into pageQueue, wait for idle, repeat
      while (!this.shuttingDown) {
        // Move all queued items into the concurrency pool
        while (this.crawlQueue.length > 0) {
          const { url, depth } = this.crawlQueue.shift();
          this.pageQueue.add(() => this._processPage(url, depth));
        }

        // If nothing is running or queued, we're done
        if (this.pageQueue.size === 0 && this.pageQueue.pending === 0) {
          break;
        }

        // Wait for all current tasks to finish (they may enqueue new items)
        await this.pageQueue.onIdle();

        // After idle, check if new items appeared in crawlQueue
        // If so, the while loop will continue and drain them
      }

      // Wait for remaining asset downloads
      this.logger.phase('downloading', 'Downloading assets...');
      if (!this.shuttingDown) {
        await this.assetQueue.onIdle();
      }

      // Rewrite all HTML and CSS files now that all assets are downloaded
      this.logger.phase('rewriting', 'Rewriting URLs...');
      if (!this.config.dryRun) {
        await this._rewriteAllPages();
      }
      await this.assetDownloader.rewriteCssFiles();

      // Write crawl report
      const report = {
        seedUrl,
        timestamp: new Date().toISOString(),
        pagesCrawled: this.logger.pagesCrawled,
        assetsSaved: this.logger.assetsSaved,
        assetsDeduplicated: this.logger.assetsDeduplicated,
        failedUrls: [...this.failedUrls].map(([url, info]) => ({
          url,
          reason: info.reason,
          attempts: info.attempts,
        })),
        failedAssets: [...this.assetDownloader.failedAssets],
      };

      if (!this.config.dryRun) {
        await this.storage.writeReport(report);
      }

      // Print summary
      this.logger.phase('done', 'Crawl complete');
      this.logger.summary(this.failedUrls);
      this.logger.info(`Output saved to: ${this.config.output}`);
    } finally {
      try {
        await this.pageProcessor.close();
      } catch {
        // Browser may have already crashed — that's fine
      }
      if (this.config.mode !== 'web') {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
      }
    }
  }

  _enqueue(url, depth) {
    if (this.shuttingDown) return;

    let normalized;
    try {
      normalized = normalizeUrl(url);
    } catch {
      return; // Invalid URL
    }

    if (this.visitedUrls.has(normalized)) return;
    if (depth > this.config.maxDepth) return;
    if (!isSameOrigin(normalized, this.config.seedUrl)) return;
    if (!isCrawlableUrl(normalized)) return;
    if (matchesExcludePattern(normalized, this.config.exclude)) return;
    if (this.config.respectRobots && !this.robots.isAllowed(normalized)) return;

    this.visitedUrls.add(normalized);
    this.crawlQueue.push({ url: normalized, depth });
    this.logger.pageDiscovered(1);
  }

  async _rewriteAllPages() {
    const fs = require('fs');
    this.logger.info('Rewriting HTML files with local asset paths...');
    for (const { url, localPath } of this.savedPages) {
      try {
        const html = await fs.promises.readFile(localPath, 'utf-8');
        const rewrittenHtml = rewriteHtml(
          html,
          url,
          this.assetManifest,
          this.config.output
        );
        await fs.promises.writeFile(localPath, rewrittenHtml, 'utf-8');
      } catch (err) {
        this.logger.warn(`Failed to rewrite HTML: ${url} - ${err.message}`);
      }
    }
  }

  _isBrowserCrash(err) {
    const msg = err.message || '';
    return (
      msg.includes('Target closed') ||
      msg.includes('Session closed') ||
      msg.includes('Browser closed') ||
      msg.includes('Protocol error') ||
      msg.includes('Connection closed') ||
      msg.includes('browser has disconnected') ||
      msg.includes('Navigation failed because browser has disconnected')
    );
  }

  async _processPage(url, depth, attempt = 1) {
    if (this.shuttingDown) return;

    try {
      // Render the page
      let result;
      if (this.config.js) {
        // Ensure browser is alive before attempting
        if (!this.pageProcessor.isConnected()) {
          try {
            await this.pageProcessor.relaunch();
          } catch (relaunchErr) {
            throw new Error(`Browser relaunch failed: ${relaunchErr.message}`);
          }
        }
        result = await this.pageProcessor.processPage(url);
      } else {
        result = await this.pageProcessor.processPageRaw(url);
      }

      // Enqueue discovered links
      for (const link of result.discoveredLinks) {
        this._enqueue(link, depth + 1);
      }

      // Queue asset downloads
      for (const assetUrl of result.assetUrls) {
        if (!this.assetManifest.has(assetUrl)) {
          this.assetQueue.add(async () => {
            try {
              const subAssetUrls = await this.assetDownloader.download(assetUrl);
              // Queue any sub-assets discovered in CSS files
              for (const subUrl of subAssetUrls) {
                if (!this.assetManifest.has(subUrl)) {
                  this.assetQueue.add(() =>
                    this.assetDownloader.download(subUrl)
                  );
                }
              }
            } catch (assetErr) {
              // Swallow individual asset errors — don't crash the queue
            }
          });
        }
      }

      if (!this.config.dryRun) {
        // Save raw HTML now; rewriting is deferred until all assets are downloaded
        const localPath = urlToLocalPath(url, this.config.output);
        await this.storage.writePage(localPath, result.html);
        this.savedPages.push({ url, localPath });
      }

      this.logger.pageCrawled(url);
    } catch (err) {
      if (this.shuttingDown) return;

      if (attempt < this.config.retries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 30000);
        this.logger.warn(
          `Retry ${attempt}/${this.config.retries} for ${url}: ${err.message}`
        );
        await new Promise((r) => setTimeout(r, backoff));

        // If Puppeteer crashed, try relaunching
        if (this._isBrowserCrash(err)) {
          try {
            await this.pageProcessor.relaunch();
          } catch (relaunchErr) {
            this.logger.error(
              `Failed to relaunch browser: ${relaunchErr.message}`
            );
          }
        }

        return this._processPage(url, depth, attempt + 1);
      }

      const reason = err.message.includes('HTTP ')
        ? err.message
        : err.constructor.name + ': ' + err.message;

      this.failedUrls.set(url, { attempts: attempt, reason });
      this.logger.error(
        `Failed after ${attempt} attempts: ${url} - ${err.message}`
      );
    }
  }
}

module.exports = Crawler;
