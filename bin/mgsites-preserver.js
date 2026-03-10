#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { preserve } = require('../src/index');
const pkg = require('../package.json');

const program = new Command();

program
  .name('mgsites-preserver')
  .description(
    'Crawl and preserve entire websites as static HTML/CSS/JS for offline viewing'
  )
  .version(pkg.version)
  .argument('<url>', 'The seed URL to start crawling from')
  .option('-o, --output <dir>', 'Output directory', './preserved-site')
  .option('-d, --max-depth <n>', 'Maximum crawl depth', '10')
  .option('-c, --concurrency <n>', 'Number of pages to process in parallel', '3')
  .option('--asset-concurrency <n>', 'Number of assets to download in parallel', '5')
  .option('--delay <ms>', 'Minimum delay between page requests in ms', '500')
  .option('--timeout <ms>', 'Navigation timeout per page in ms', '30000')
  .option('--retries <n>', 'Max retry attempts for failed requests', '3')
  .option('--respect-robots', 'Honor robots.txt rules', false)
  .option('--no-js', 'Download raw HTML without Puppeteer rendering')
  .option('--user-agent <string>', 'Custom User-Agent string')
  .option(
    '--include-query-strings',
    'Treat URLs with different query strings as distinct pages',
    false
  )
  .option(
    '--exclude <pattern...>',
    'URL patterns to exclude (glob-style, repeatable)'
  )
  .option('--verbose', 'Enable verbose logging', false)
  .option('--dry-run', 'Crawl and report without saving files', false)
  .action(async (url, opts) => {
    // Validate URL
    try {
      new URL(url);
    } catch {
      // Try prepending https://
      try {
        url = 'https://' + url;
        new URL(url);
      } catch {
        console.error(`Error: Invalid URL "${url}"`);
        process.exit(1);
      }
    }

    try {
      await preserve(url, opts);
    } catch (err) {
      console.error(`\nFatal error: ${err.message}`);
      if (opts.verbose) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  });

program.parse();
