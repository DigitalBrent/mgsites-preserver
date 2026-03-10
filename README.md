# mgsites-preserver

Crawl and preserve entire websites as static HTML/CSS/JS for offline viewing.

MGSites Preserver recursively crawls a website, downloads all pages and assets, rewrites URLs to relative local paths, and outputs a fully functional offline archive.

## Features

- Full website archival with configurable crawl depth
- JavaScript rendering via Puppeteer (headless Chrome) or raw HTML mode
- Comprehensive asset extraction (images, CSS, JS, fonts, media, favicons, OG images)
- SHA-256 content-based asset deduplication
- URL rewriting for complete offline functionality
- robots.txt compliance (optional)
- Concurrent page and asset processing with rate limiting
- Retry logic with exponential backoff
- Graceful shutdown on SIGINT/SIGTERM
- Detailed JSON crawl reports
- Dry-run mode for testing

## Installation

```bash
# Clone and install dependencies
npm install

# Optional: link for global CLI access
npm link
```

## Quick Start

```bash
# Preserve a website (default: depth 10, output to ./preserved-site/)
node bin/mgsites-preserver.js https://example.com

# Shallow crawl with verbose output
node bin/mgsites-preserver.js https://example.com --max-depth 2 --verbose

# Raw HTML mode (no JavaScript rendering)
node bin/mgsites-preserver.js https://example.com --no-js

# Custom output directory
node bin/mgsites-preserver.js https://example.com -o ./my-archive
```

## CLI Options

```
Usage: mgsites-preserver <url> [options]

Arguments:
  url                         The seed URL to start crawling from

Options:
  -o, --output <dir>          Output directory (default: "./preserved-site")
  -d, --max-depth <n>         Maximum crawl depth (default: "10")
  -c, --concurrency <n>       Pages to process in parallel (default: "3")
  --asset-concurrency <n>     Assets to download in parallel (default: "5")
  --delay <ms>                Min delay between page requests in ms (default: "500")
  --timeout <ms>              Navigation timeout per page in ms (default: "30000")
  --retries <n>               Max retry attempts for failed requests (default: "3")
  --respect-robots            Honor robots.txt rules (default: false)
  --no-js                     Download raw HTML without Puppeteer rendering
  --ignore-ssl-errors         Skip SSL certificate verification (default: false)
  --user-agent <string>       Custom User-Agent string
  --include-query-strings     Treat URLs with different query strings as distinct pages
  --exclude <pattern...>      URL patterns to exclude (glob-style, repeatable)
  --verbose                   Enable verbose logging (default: false)
  --dry-run                   Crawl and report without saving files (default: false)
  -V, --version               Output the version number
  -h, --help                  Display help
```

## Programmatic API

```javascript
const { preserve } = require('mgsites-preserver');

await preserve('https://example.com', {
  output: './my-archive',
  maxDepth: 5,
  concurrency: 2,
  verbose: true,
});
```

## Output Structure

```
preserved-site/
├── index.html                  # Root page
├── about/
│   └── index.html              # Nested pages
├── assets/
│   ├── css/
│   ├── js/
│   ├── images/
│   └── ...
└── crawl-report.json           # Crawl metadata and stats
```

The `crawl-report.json` includes the seed URL, timestamp, pages crawled, assets saved, deduplicated asset count, and any failed URLs with reasons.

## How It Works

1. Seeds the crawl queue with the provided URL
2. Processes pages concurrently — renders with Puppeteer (or fetches raw HTML)
3. Extracts all links and asset URLs from each page
4. Queues discovered same-origin links for crawling (up to max depth)
5. Downloads assets with content-hash deduplication
6. Rewrites all URLs in HTML and CSS to relative local paths
7. Writes the offline archive and crawl report to disk

## License

MIT
