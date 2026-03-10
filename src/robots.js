'use strict';

const https = require('https');
const http = require('http');
const robotsParser = require('robots-parser');

class Robots {
  constructor() {
    this.parser = null;
    this.enabled = false;
  }

  async fetch(seedUrl) {
    const { URL } = require('url');
    const parsed = new URL(seedUrl);
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;

    try {
      const body = await this._httpGet(robotsUrl);
      this.parser = robotsParser(robotsUrl, body);
      this.enabled = true;
    } catch {
      // No robots.txt or fetch failed — allow everything
      this.parser = null;
      this.enabled = false;
    }
  }

  isAllowed(url, userAgent = '*') {
    if (!this.enabled || !this.parser) return true;
    return this.parser.isAllowed(url, userAgent);
  }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      mod
        .get(url, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(body));
          res.on('error', reject);
        })
        .on('error', reject);
    });
  }
}

module.exports = Robots;
