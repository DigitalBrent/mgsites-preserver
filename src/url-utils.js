'use strict';

const { URL } = require('url');
const path = require('path');

/**
 * Normalize a URL for deduplication and consistent comparison.
 */
function normalizeUrl(rawUrl, baseUrl) {
  const resolved = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);

  // Strip hash fragments
  resolved.hash = '';

  // Sort query parameters
  resolved.searchParams.sort();

  // Remove default ports
  if (
    (resolved.protocol === 'http:' && resolved.port === '80') ||
    (resolved.protocol === 'https:' && resolved.port === '443')
  ) {
    resolved.port = '';
  }

  // Remove trailing slash for non-root paths
  if (resolved.pathname !== '/' && resolved.pathname.endsWith('/')) {
    resolved.pathname = resolved.pathname.slice(0, -1);
  }

  return resolved.href;
}

/**
 * Check if a URL belongs to the same origin (hostname) as the seed URL.
 */
function isSameOrigin(candidateUrl, seedUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const seed = new URL(seedUrl);
    return candidate.hostname === seed.hostname;
  } catch {
    return false;
  }
}

/**
 * Convert a page URL to a local filesystem path.
 */
function urlToLocalPath(pageUrl, outputDir) {
  const parsed = new URL(pageUrl);
  let filePath = decodeURIComponent(parsed.pathname);

  // Encode query strings into the filename
  if (parsed.search) {
    const querySlug = parsed.search
      .slice(1)
      .replace(/[^a-zA-Z0-9=&_-]/g, '_');
    filePath = filePath + '_' + querySlug;
  }

  // Determine if path looks like a file with an extension
  const ext = path.extname(filePath);
  const htmlExtensions = /\.(html?|php|asp|aspx|jsp|cgi)$/i;

  if (!ext || !htmlExtensions.test(filePath)) {
    // Treat as a directory — add index.html
    filePath = path.join(filePath, 'index.html');
  }

  // Clean up leading slash to make it relative
  if (filePath.startsWith('/')) {
    filePath = filePath.slice(1);
  }

  return path.join(outputDir, filePath);
}

/**
 * Convert an asset URL to a local filesystem path, preserving the path structure.
 */
function assetUrlToLocalPath(assetUrl, outputDir) {
  const parsed = new URL(assetUrl);
  let filePath = decodeURIComponent(parsed.pathname);

  // Clean up leading slash
  if (filePath.startsWith('/')) {
    filePath = filePath.slice(1);
  }

  // If no file extension, we'll handle this at download time with mime-types
  return path.join(outputDir, filePath);
}

/**
 * Check if a URL matches any exclusion pattern.
 * Patterns use simple glob-style matching (supports * wildcard).
 */
function matchesExcludePattern(url, patterns) {
  if (!patterns || patterns.length === 0) return false;

  const parsed = new URL(url);
  const urlPath = parsed.pathname;

  for (const pattern of patterns) {
    // Convert glob pattern to regex
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexStr}$`);
    if (regex.test(urlPath)) return true;
  }

  return false;
}

/**
 * Check if a URL is crawlable (not a binary file, not a special protocol).
 */
function isCrawlableUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    // Skip known binary/non-page file extensions
    const nonPageExtensions = /\.(pdf|zip|tar|gz|rar|7z|exe|dmg|iso|mp3|mp4|avi|mov|wmv|flv|mkv|doc|docx|xls|xlsx|ppt|pptx)$/i;
    if (nonPageExtensions.test(parsed.pathname)) return false;

    return true;
  } catch {
    return false;
  }
}

module.exports = {
  normalizeUrl,
  isSameOrigin,
  urlToLocalPath,
  assetUrlToLocalPath,
  matchesExcludePattern,
  isCrawlableUrl,
};
