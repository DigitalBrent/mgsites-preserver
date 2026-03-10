'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class Storage {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.hashToPath = new Map(); // contentHash -> localPath (relative to outputDir)
  }

  async init() {
    await fs.promises.mkdir(this.outputDir, { recursive: true });
  }

  /**
   * Write an asset (image, font, CSS, JS, etc.) to disk with content-hash deduplication.
   * Returns { localPath, contentHash, deduplicated }.
   */
  async writeAsset(localPath, buffer) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    if (this.hashToPath.has(hash)) {
      return {
        localPath: this.hashToPath.get(hash),
        contentHash: hash,
        deduplicated: true,
      };
    }

    const fullPath = path.resolve(this.outputDir, localPath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, buffer);

    this.hashToPath.set(hash, localPath);
    return { localPath, contentHash: hash, deduplicated: false };
  }

  /**
   * Write an HTML page to disk.
   */
  async writePage(localPath, html) {
    const fullPath = path.isAbsolute(localPath)
      ? localPath
      : path.resolve(this.outputDir, localPath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, html, 'utf-8');
  }

  /**
   * Write the crawl report JSON.
   */
  async writeReport(report) {
    const reportPath = path.join(this.outputDir, 'crawl-report.json');
    await fs.promises.writeFile(
      reportPath,
      JSON.stringify(report, null, 2),
      'utf-8'
    );
  }
}

module.exports = Storage;
