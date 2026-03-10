'use strict';

const path = require('path');

const DEFAULTS = {
  output: './preserved-site',
  maxDepth: 10,
  concurrency: 3,
  assetConcurrency: 5,
  delay: 500,
  timeout: 30000,
  retries: 3,
  respectRobots: false,
  ignoreSslErrors: false,
  js: true,
  userAgent: null,
  includeQueryStrings: false,
  exclude: [],
  verbose: false,
  dryRun: false,
};

function createConfig(url, opts = {}) {
  const config = { ...DEFAULTS, ...opts };
  config.seedUrl = url;
  config.output = path.resolve(config.output);

  // Parse numeric options that may come as strings from CLI
  config.maxDepth = parseInt(config.maxDepth, 10);
  config.concurrency = parseInt(config.concurrency, 10);
  config.assetConcurrency = parseInt(config.assetConcurrency, 10);
  config.delay = parseInt(config.delay, 10);
  config.timeout = parseInt(config.timeout, 10);
  config.retries = parseInt(config.retries, 10);

  return config;
}

module.exports = { createConfig, DEFAULTS };
