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
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
    ];
    if (this.config.ignoreSslErrors) {
      args.push('--ignore-certificate-errors');
    }
    const launchOpts = {
      headless: 'new',
      args,
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    this.browser = await puppeteer.launch(launchOpts);

    // Listen for browser disconnect so we know it crashed
    this.browser.on('disconnected', () => {
      this.browser = null;
    });
  }

  async processPage(url) {
    // Check browser is still alive before trying
    if (!this.browser || !this.browser.isConnected()) {
      throw new Error('Browser closed');
    }

    const page = await this.browser.newPage();

    try {
      // Use a capped timeout to prevent indefinite hangs
      const pageTimeout = Math.min(this.config.timeout || 30000, 45000);
      page.setDefaultNavigationTimeout(pageTimeout);

      if (this.config.userAgent) {
        await page.setUserAgent(this.config.userAgent);
      }

      await page.setViewport({ width: 1280, height: 800 });

      // Use networkidle2 instead of networkidle0 — idle0 hangs on sites with
      // persistent connections (analytics pings, websockets, live chat, etc.)
      try {
        await page.goto(url, { waitUntil: 'networkidle2' });
      } catch (navErr) {
        // If navigation times out, still try to get whatever content loaded
        if (navErr.name === 'TimeoutError' || navErr.message.includes('timeout')) {
          // Page partially loaded — continue with what we have
        } else {
          throw navErr;
        }
      }

      // Bake computed visibility into inline styles so JS-hidden elements
      // stay hidden when the preserved page is opened offline (no JS).
      // At this viewport width (1280x800), the site's JS has already run
      // and hidden mobile-only elements, scroll-triggered overlays, etc.
      // We capture that state into inline styles before extracting HTML.
      // Only process <body> elements — <head> elements (link, script, style, meta)
      // always compute as display:none and we must NOT bake that in.
      await page.evaluate(() => {
        const body = document.body;
        if (!body) return;
        const all = body.querySelectorAll('*');
        for (const el of all) {
          try {
            const cs = window.getComputedStyle(el);
            // Bake display:none for elements hidden by JS/CSS at this viewport
            if (cs.display === 'none' && el.style.display !== 'none') {
              el.style.display = 'none';
            }
            // Bake visibility:hidden
            if (cs.visibility === 'hidden' && el.style.visibility !== 'hidden') {
              el.style.visibility = 'hidden';
            }
          } catch {
            // getComputedStyle can fail on pseudo-elements, SVG, etc.
          }
        }
      });

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
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch {
        // Page or browser may have already been destroyed
      }
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
      try {
        await this.browser.close();
      } catch {
        // Browser may have already crashed / disconnected
      }
      this.browser = null;
    }
  }

  async relaunch() {
    await this.close();
    await this.init();
  }

  isConnected() {
    return this.browser && this.browser.isConnected();
  }
}

module.exports = PageProcessor;
