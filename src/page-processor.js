'use strict';

const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

class PageProcessor {
  constructor(config) {
    this.config = config;
    this.browser = null;
  }

  async init() {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ];
    if (this.config.ignoreSslErrors) {
      args.push('--ignore-certificate-errors');
    }
    this.browser = await puppeteer.launch({
      headless: 'new',
      args,
    });
  }

  async processPage(url) {
    const page = await this.browser.newPage();

    try {
      page.setDefaultNavigationTimeout(this.config.timeout);

      if (this.config.userAgent) {
        await page.setUserAgent(this.config.userAgent);
      }

      await page.setViewport({ width: 1280, height: 800 });

      // Navigate and wait for JS to finish rendering
      await page.goto(url, { waitUntil: 'networkidle0' });

      // Get the fully rendered HTML
      const html = await page.content();

      // Parse with cheerio to extract links and assets
      const $ = cheerio.load(html);
      const discoveredLinks = new Set();
      const assetUrls = new Set();

      // Extract page links (for crawling)
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && !this._isSkippableHref(href)) {
          try {
            discoveredLinks.add(new URL(href, url).href);
          } catch {
            // Invalid URL, skip
          }
        }
      });

      // Extract images
      $('img[src]').each((_, el) => {
        this._addAssetUrl($, el, 'src', url, assetUrls);
      });
      $('img[data-src]').each((_, el) => {
        this._addAssetUrl($, el, 'data-src', url, assetUrls);
      });

      // Extract srcset
      $('[srcset]').each((_, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
          srcset.split(',').forEach((entry) => {
            const src = entry.trim().split(/\s+/)[0];
            if (src) {
              try {
                assetUrls.add(new URL(src, url).href);
              } catch {
                // skip
              }
            }
          });
        }
      });

      // Extract CSS files
      $('link[rel="stylesheet"][href]').each((_, el) => {
        this._addAssetUrl($, el, 'href', url, assetUrls);
      });

      // Extract JS files
      $('script[src]').each((_, el) => {
        this._addAssetUrl($, el, 'src', url, assetUrls);
      });

      // Extract video/audio sources
      $('video[src], audio[src], source[src]').each((_, el) => {
        this._addAssetUrl($, el, 'src', url, assetUrls);
      });
      $('video[poster]').each((_, el) => {
        this._addAssetUrl($, el, 'poster', url, assetUrls);
      });

      // Extract favicon and other link assets
      $('link[href]').each((_, el) => {
        const rel = ($(el).attr('rel') || '').toLowerCase();
        if (
          [
            'icon',
            'shortcut icon',
            'apple-touch-icon',
            'apple-touch-icon-precomposed',
            'manifest',
          ].includes(rel)
        ) {
          this._addAssetUrl($, el, 'href', url, assetUrls);
        }
      });

      // Extract Open Graph / meta images
      $(
        'meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:url"]'
      ).each((_, el) => {
        const content = $(el).attr('content');
        if (content) {
          try {
            assetUrls.add(new URL(content, url).href);
          } catch {
            // skip
          }
        }
      });

      // Extract CSS url() references from inline styles and <style> blocks
      $('[style]').each((_, el) => {
        const style = $(el).attr('style');
        if (style) this._extractCssUrlsToSet(style, url, assetUrls);
      });
      $('style').each((_, el) => {
        const css = $(el).html();
        if (css) this._extractCssUrlsToSet(css, url, assetUrls);
      });

      return {
        html,
        discoveredLinks: [...discoveredLinks],
        assetUrls: [...assetUrls],
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Fetch raw HTML without Puppeteer (for --no-js mode).
   */
  async processPageRaw(url) {
    const https = require('https');
    const http = require('http');

    const html = await new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const opts = { timeout: this.config.timeout };
      if (this.config.ignoreSslErrors) {
        opts.rejectUnauthorized = false;
      }
      mod
        .get(url, opts, (res) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            this.processPageRaw(new URL(res.headers.location, url).href)
              .then(resolve)
              .catch(reject);
            return;
          }
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

    // Use same extraction logic as Puppeteer path
    const $ = cheerio.load(html);
    const discoveredLinks = new Set();
    const assetUrls = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && !this._isSkippableHref(href)) {
        try {
          discoveredLinks.add(new URL(href, url).href);
        } catch {}
      }
    });

    // Same asset extraction as above (simplified — reuses same patterns)
    $('img[src]').each((_, el) => this._addAssetUrl($, el, 'src', url, assetUrls));
    $('img[data-src]').each((_, el) => this._addAssetUrl($, el, 'data-src', url, assetUrls));
    $('link[rel="stylesheet"][href]').each((_, el) => this._addAssetUrl($, el, 'href', url, assetUrls));
    $('script[src]').each((_, el) => this._addAssetUrl($, el, 'src', url, assetUrls));
    $('video[src], audio[src], source[src]').each((_, el) => this._addAssetUrl($, el, 'src', url, assetUrls));
    $('video[poster]').each((_, el) => this._addAssetUrl($, el, 'poster', url, assetUrls));
    $('[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (srcset) {
        srcset.split(',').forEach((entry) => {
          const src = entry.trim().split(/\s+/)[0];
          if (src) {
            try { assetUrls.add(new URL(src, url).href); } catch {}
          }
        });
      }
    });
    $('link[href]').each((_, el) => {
      const rel = ($(el).attr('rel') || '').toLowerCase();
      if (['icon', 'shortcut icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'manifest'].includes(rel)) {
        this._addAssetUrl($, el, 'href', url, assetUrls);
      }
    });

    return {
      html,
      discoveredLinks: [...discoveredLinks],
      assetUrls: [...assetUrls],
    };
  }

  _isSkippableHref(href) {
    return (
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('data:')
    );
  }

  _addAssetUrl($, el, attr, baseUrl, assetUrls) {
    const val = $(el).attr(attr);
    if (val && !val.startsWith('data:') && !val.startsWith('blob:')) {
      try {
        assetUrls.add(new URL(val, baseUrl).href);
      } catch {
        // Invalid URL, skip
      }
    }
  }

  _extractCssUrlsToSet(cssText, baseUrl, assetUrls) {
    cssText.replace(
      /url\(\s*(['"]?)(.*?)\1\s*\)/g,
      (match, quote, rawUrl) => {
        const trimmed = rawUrl.trim();
        if (trimmed && !trimmed.startsWith('data:')) {
          try {
            assetUrls.add(new URL(trimmed, baseUrl).href);
          } catch {}
        }
      }
    );
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async relaunch() {
    await this.close();
    await this.init();
  }
}

module.exports = PageProcessor;
