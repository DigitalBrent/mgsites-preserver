'use strict';

const { createConfig } = require('./config');
const Crawler = require('./crawler');

/**
 * Preserve a website as static HTML/CSS/JS.
 *
 * @param {string} url - The seed URL to start crawling from.
 * @param {object} opts - Configuration options (see config.js for defaults).
 */
async function preserve(url, opts = {}) {
  const config = createConfig(url, opts);
  const crawler = new Crawler(config);
  await crawler.crawl();
}

/**
 * Create a preserver instance without starting it.
 * Useful for web mode where the server needs access to the crawler/logger
 * before calling crawl().
 */
function createPreserver(url, opts = {}) {
  const config = createConfig(url, opts);
  const crawler = new Crawler(config);
  return { crawler, config };
}

module.exports = { preserve, createPreserver };
