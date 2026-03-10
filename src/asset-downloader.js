'use strict';

const https = require('https');
const http = require('http');
const path = require('path');
const mime = require('mime-types');
const { assetUrlToLocalPath } = require('./url-utils');
const { extractCssUrls, rewriteCssFile } = require('./rewriter');

class AssetDownloader {
  constructor(config, storage, assetManifest, logger) {
    this.config = config;
    this.storage = storage;
    this.assetManifest = assetManifest;
    this.logger = logger;
    this.pendingCssSubAssets = []; // URLs discovered inside CSS files
  }

  /**
   * Download an asset and save it to disk.
   * Returns sub-asset URLs if the asset is a CSS file.
   */
  async download(assetUrl) {
    // Skip if already downloaded
    const normalized = assetUrl;
    if (this.assetManifest.has(normalized)) {
      return [];
    }

    try {
      const { buffer, contentType } = await this._httpGetBinary(assetUrl);
      let localPath = this._computeLocalPath(assetUrl, contentType);

      // Make localPath relative to outputDir
      if (path.isAbsolute(localPath)) {
        localPath = path.relative(this.config.output, localPath);
      }

      let subAssetUrls = [];

      // If it's a CSS file, extract sub-asset references and rewrite URLs
      if (this._isCss(assetUrl, contentType)) {
        const cssText = buffer.toString('utf-8');
        subAssetUrls = extractCssUrls(cssText, assetUrl);

        // We'll rewrite CSS after all sub-assets are downloaded
        // For now, store the original
        const result = await this.storage.writeAsset(localPath, buffer);
        this.assetManifest.set(normalized, {
          localPath: path.resolve(this.config.output, result.localPath),
          contentHash: result.contentHash,
          isCss: true,
          cssUrl: assetUrl,
        });
        this.logger.assetSaved(assetUrl, result.deduplicated);
        return subAssetUrls;
      }

      const result = await this.storage.writeAsset(localPath, buffer);
      this.assetManifest.set(normalized, {
        localPath: path.resolve(this.config.output, result.localPath),
        contentHash: result.contentHash,
      });
      this.logger.assetSaved(assetUrl, result.deduplicated);
      return [];
    } catch (err) {
      this.logger.warn(`Failed to download asset: ${assetUrl} - ${err.message}`);
      return [];
    }
  }

  /**
   * Rewrite all downloaded CSS files after all assets are collected.
   */
  async rewriteCssFiles() {
    const fs = require('fs');
    for (const [url, entry] of this.assetManifest) {
      if (!entry.isCss) continue;

      try {
        const cssContent = await fs.promises.readFile(entry.localPath, 'utf-8');
        const rewritten = rewriteCssFile(
          cssContent,
          entry.cssUrl,
          this.assetManifest,
          this.config.output
        );
        await fs.promises.writeFile(entry.localPath, rewritten, 'utf-8');
      } catch (err) {
        this.logger.warn(`Failed to rewrite CSS: ${url} - ${err.message}`);
      }
    }
  }

  _computeLocalPath(assetUrl, contentType) {
    let localPath = assetUrlToLocalPath(assetUrl, this.config.output);

    // If the path has no file extension, add one from the content type
    const ext = path.extname(localPath);
    if (!ext && contentType) {
      const mimeExt = mime.extension(contentType);
      if (mimeExt) {
        localPath = localPath + '.' + mimeExt;
      }
    }

    return localPath;
  }

  _isCss(url, contentType) {
    if (contentType && contentType.includes('text/css')) return true;
    if (url.endsWith('.css')) return true;
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('.css')) return true;
    return false;
  }

  _httpGetBinary(url, redirectCount = 0) {
    if (redirectCount > 5) {
      return Promise.reject(new Error('Too many redirects'));
    }

    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const options = {
        timeout: this.config.timeout,
        headers: {},
      };

      if (this.config.userAgent) {
        options.headers['User-Agent'] = this.config.userAgent;
      }

      mod
        .get(url, options, (res) => {
          // Follow redirects
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const redirectUrl = new URL(res.headers.location, url).href;
            this._httpGetBinary(redirectUrl, redirectCount + 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }

          const contentType = res.headers['content-type'] || '';
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              buffer: Buffer.concat(chunks),
              contentType: contentType.split(';')[0].trim(),
            })
          );
          res.on('error', reject);
        })
        .on('error', reject);
    });
  }
}

module.exports = AssetDownloader;
