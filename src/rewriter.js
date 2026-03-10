'use strict';

const cheerio = require('cheerio');
const path = require('path');
const { normalizeUrl, urlToLocalPath, assetUrlToLocalPath } = require('./url-utils');

/**
 * Rewrite all URLs in an HTML document to use relative local paths.
 */
function rewriteHtml(html, pageUrl, assetManifest, outputDir) {
  const $ = cheerio.load(html);
  const pageLocalPath = urlToLocalPath(pageUrl, outputDir);
  const pageDir = path.dirname(pageLocalPath);

  // HTML attributes that contain URLs
  const attrSelectors = [
    { selector: 'img[src]', attr: 'src' },
    { selector: 'img[data-src]', attr: 'data-src' },
    { selector: 'script[src]', attr: 'src' },
    { selector: 'link[href]', attr: 'href' },
    { selector: 'a[href]', attr: 'href' },
    { selector: 'video[src]', attr: 'src' },
    { selector: 'video[poster]', attr: 'poster' },
    { selector: 'audio[src]', attr: 'src' },
    { selector: 'source[src]', attr: 'src' },
    { selector: 'embed[src]', attr: 'src' },
    { selector: 'object[data]', attr: 'data' },
    { selector: 'form[action]', attr: 'action' },
    { selector: 'iframe[src]', attr: 'src' },
  ];

  for (const { selector, attr } of attrSelectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const originalValue = $el.attr(attr);
      if (!originalValue) return;

      const rewritten = rewriteSingleUrl(
        originalValue,
        pageUrl,
        pageDir,
        assetManifest,
        outputDir
      );
      if (rewritten !== null) {
        $el.attr(attr, rewritten);
      }
    });
  }

  // Handle srcset attributes (img, source)
  $('[srcset]').each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr('srcset');
    if (!srcset) return;
    $el.attr(
      'srcset',
      rewriteSrcset(srcset, pageUrl, pageDir, assetManifest, outputDir)
    );
  });

  // Rewrite inline style attributes
  $('[style]').each((_, el) => {
    const $el = $(el);
    const style = $el.attr('style');
    if (style) {
      $el.attr(
        'style',
        rewriteCssUrls(style, pageUrl, pageDir, assetManifest, outputDir)
      );
    }
  });

  // Rewrite <style> blocks
  $('style').each((_, el) => {
    const $el = $(el);
    const css = $el.html();
    if (css) {
      $el.html(
        rewriteCssUrls(css, pageUrl, pageDir, assetManifest, outputDir)
      );
    }
  });

  return $.html();
}

/**
 * Rewrite a single URL to a relative local path.
 */
function rewriteSingleUrl(
  originalUrl,
  contextUrl,
  contextDir,
  assetManifest,
  outputDir
) {
  // Skip special protocols and data URIs
  if (/^(data:|javascript:|mailto:|tel:|#|blob:)/.test(originalUrl.trim())) {
    return originalUrl;
  }

  try {
    const absoluteUrl = new URL(originalUrl, contextUrl).href;
    let normalized;
    try {
      normalized = normalizeUrl(absoluteUrl);
    } catch {
      normalized = absoluteUrl;
    }

    // Check if we have this in the asset manifest (try normalized and absolute)
    const assetEntry = assetManifest.get(normalized) || assetManifest.get(absoluteUrl);
    if (assetEntry) {
      return path.relative(contextDir, assetEntry.localPath);
    }

    // Check if it's a crawled page (try the page path)
    const pageLocalPath = urlToLocalPath(normalized, outputDir);
    // Check by computing what the relative path would be
    const relativePath = path.relative(contextDir, pageLocalPath);

    // Only rewrite if it's a same-origin URL
    const contextParsed = new URL(contextUrl);
    const targetParsed = new URL(absoluteUrl);
    if (contextParsed.hostname === targetParsed.hostname) {
      return relativePath;
    }

    // External URL — leave as-is
    return originalUrl;
  } catch {
    return originalUrl;
  }
}

/**
 * Rewrite srcset attribute value.
 */
function rewriteSrcset(
  srcsetValue,
  contextUrl,
  contextDir,
  assetManifest,
  outputDir
) {
  return srcsetValue
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts.slice(1).join(' ');
      const rewritten = rewriteSingleUrl(
        url,
        contextUrl,
        contextDir,
        assetManifest,
        outputDir
      );
      return descriptor ? `${rewritten} ${descriptor}` : rewritten;
    })
    .join(', ');
}

/**
 * Rewrite url() and @import references in CSS text.
 */
function rewriteCssUrls(
  cssText,
  contextUrl,
  contextDir,
  assetManifest,
  outputDir
) {
  let result = cssText;

  // Rewrite url() references
  result = result.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/g,
    (match, quote, rawUrl) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || trimmed.startsWith('data:')) return match;
      const rewritten = rewriteSingleUrl(
        trimmed,
        contextUrl,
        contextDir,
        assetManifest,
        outputDir
      );
      return `url(${quote}${rewritten}${quote})`;
    }
  );

  // Rewrite @import references
  result = result.replace(
    /@import\s+(['"])(.*?)\1/g,
    (match, quote, rawUrl) => {
      const rewritten = rewriteSingleUrl(
        rawUrl.trim(),
        contextUrl,
        contextDir,
        assetManifest,
        outputDir
      );
      return `@import ${quote}${rewritten}${quote}`;
    }
  );

  return result;
}

/**
 * Rewrite URLs inside a standalone CSS file.
 */
function rewriteCssFile(cssText, cssUrl, assetManifest, outputDir) {
  const cssLocalPath = assetUrlToLocalPath(cssUrl, outputDir);
  const cssDir = path.dirname(cssLocalPath);
  return rewriteCssUrls(cssText, cssUrl, cssDir, assetManifest, outputDir);
}

/**
 * Extract url() references from CSS text for sub-asset discovery.
 */
function extractCssUrls(cssText, cssUrl) {
  const urls = [];

  cssText.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/g,
    (match, quote, rawUrl) => {
      const trimmed = rawUrl.trim();
      if (trimmed && !trimmed.startsWith('data:')) {
        try {
          urls.push(new URL(trimmed, cssUrl).href);
        } catch {
          // Invalid URL, skip
        }
      }
    }
  );

  cssText.replace(/@import\s+(['"])(.*?)\1/g, (match, quote, rawUrl) => {
    try {
      urls.push(new URL(rawUrl.trim(), cssUrl).href);
    } catch {
      // Invalid URL, skip
    }
  });

  return urls;
}

module.exports = {
  rewriteHtml,
  rewriteSingleUrl,
  rewriteSrcset,
  rewriteCssUrls,
  rewriteCssFile,
  extractCssUrls,
};
