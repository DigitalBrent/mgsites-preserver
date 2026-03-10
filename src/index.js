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

module.exports = { preserve };
