'use strict';

const chalk = require('chalk');
const cliProgress = require('cli-progress');

class Logger {
  constructor(config) {
    this.verbose = config.verbose;
    this.pagesDiscovered = 0;
    this.pagesCrawled = 0;
    this.assetsSaved = 0;
    this.assetsDeduplicated = 0;
    this.progressBar = null;
  }

  startProgress() {
    this.progressBar = new cliProgress.SingleBar(
      {
        format:
          chalk.cyan('{bar}') +
          ' | {percentage}% | Pages: {pagesCrawled}/{pagesDiscovered} | Assets: {assetsSaved}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
        clearOnComplete: false,
      },
      cliProgress.Presets.shades_classic
    );
    this.progressBar.start(1, 0, {
      pagesCrawled: 0,
      pagesDiscovered: 1,
      assetsSaved: 0,
    });
  }

  updateProgress() {
    if (this.progressBar) {
      this.progressBar.setTotal(this.pagesDiscovered);
      this.progressBar.update(this.pagesCrawled, {
        pagesCrawled: this.pagesCrawled,
        pagesDiscovered: this.pagesDiscovered,
        assetsSaved: this.assetsSaved,
      });
    }
  }

  stopProgress() {
    if (this.progressBar) {
      this.progressBar.stop();
    }
  }

  pageCrawled(url) {
    this.pagesCrawled++;
    this.updateProgress();
    if (this.verbose) {
      this.info(`Page saved: ${url}`);
    }
  }

  pageDiscovered(count) {
    this.pagesDiscovered += count;
    this.updateProgress();
  }

  assetSaved(url, deduplicated) {
    if (deduplicated) {
      this.assetsDeduplicated++;
    } else {
      this.assetsSaved++;
    }
    this.updateProgress();
    if (this.verbose) {
      const tag = deduplicated ? ' (dedup)' : '';
      this.info(`Asset saved${tag}: ${url}`);
    }
  }

  info(msg) {
    if (this.progressBar) this.progressBar.stop();
    console.log(chalk.blue('  info ') + msg);
    if (this.progressBar) {
      this.progressBar.start(this.pagesDiscovered, this.pagesCrawled, {
        pagesCrawled: this.pagesCrawled,
        pagesDiscovered: this.pagesDiscovered,
        assetsSaved: this.assetsSaved,
      });
    }
  }

  warn(msg) {
    if (this.progressBar) this.progressBar.stop();
    console.log(chalk.yellow('  warn ') + msg);
    if (this.progressBar) {
      this.progressBar.start(this.pagesDiscovered, this.pagesCrawled, {
        pagesCrawled: this.pagesCrawled,
        pagesDiscovered: this.pagesDiscovered,
        assetsSaved: this.assetsSaved,
      });
    }
  }

  error(msg) {
    if (this.progressBar) this.progressBar.stop();
    console.error(chalk.red(' error ') + msg);
    if (this.progressBar) {
      this.progressBar.start(this.pagesDiscovered, this.pagesCrawled, {
        pagesCrawled: this.pagesCrawled,
        pagesDiscovered: this.pagesDiscovered,
        assetsSaved: this.assetsSaved,
      });
    }
  }

  summary(failedUrls) {
    this.stopProgress();
    console.log('');
    console.log(chalk.bold('Crawl complete.'));
    console.log(`  Pages crawled:     ${chalk.green(this.pagesCrawled)}`);
    console.log(`  Assets saved:      ${chalk.green(this.assetsSaved)}`);
    console.log(`  Assets deduped:    ${chalk.yellow(this.assetsDeduplicated)}`);
    console.log(`  Failed URLs:       ${chalk.red(failedUrls.size)}`);
    console.log('');

    if (failedUrls.size > 0) {
      console.log(chalk.bold('Failed URLs:'));
      for (const [url, info] of failedUrls) {
        console.log(`  ${chalk.red('[' + info.reason + ']')} ${url}`);
      }
      console.log('');
    }
  }
}

module.exports = Logger;
