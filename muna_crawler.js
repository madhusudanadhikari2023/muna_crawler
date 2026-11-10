#!/usr/bin/env node

/**
 * Muna magazine crawler
 *
 * Crawls https://gorkhapatraonline.com/publications/muna by fetching numbered archive pages,
 * opening each article, extracting title + full text content, and writing:
 *
 * 1) corpus.txt  -> full article texts
 * 2) titles.txt  -> one title per line (index)
 *
 * Usage:
 *   npm i playwright
 *   node muna_crawler.js
 *
 * Optional environment variables:
 *   START_URL=...            (default: Muna publication URL)
 *   MAX_ARCHIVE_PAGES=...    (default: read to the end of the archive)
 *   ARCHIVE_WAIT_MS=1000     (default: 1000)
 *   ARTICLE_WAIT_MS=1500     (default: 1500)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const START_URL = process.env.START_URL || 'https://gorkhapatraonline.com/publications/muna';
const MAX_ARCHIVE_PAGES = Number(process.env.MAX_ARCHIVE_PAGES || process.env.MAX_SCROLL_ROUNDS || Infinity);
const ARCHIVE_WAIT_MS = Number(process.env.ARCHIVE_WAIT_MS || process.env.SCROLL_WAIT_MS || 1000);
const ARTICLE_WAIT_MS = Number(process.env.ARTICLE_WAIT_MS || 1500);

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const CORPUS_PATH = path.join(OUTPUT_DIR, 'corpus.txt');
const TITLES_PATH = path.join(OUTPUT_DIR, 'titles.txt');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

async function collectArticleLinks(page) {
  if (MAX_ARCHIVE_PAGES !== Infinity && (!Number.isSafeInteger(MAX_ARCHIVE_PAGES) || MAX_ARCHIVE_PAGES < 1)) {
    throw new Error('MAX_ARCHIVE_PAGES must be a positive integer');
  }
  if (!Number.isFinite(ARCHIVE_WAIT_MS) || ARCHIVE_WAIT_MS < 0) {
    throw new Error('ARCHIVE_WAIT_MS must be a nonnegative number');
  }

  async function readArchivePage(pageNumber) {
    return page.evaluate(async (number) => {
      let root = document.querySelector('#main');
      if (number === 1) {
        if (!root?.querySelector('#scrolling-pagination')) {
          throw new Error('Muna archive listing was missing');
        }
      } else {
        const url = new URL(location.href);
        url.searchParams.set('page', number);
        const response = await fetch(url, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const { htmlResponse } = await response.json();
        if (typeof htmlResponse !== 'string') {
          throw new Error('Missing htmlResponse in archive response');
        }
        if (htmlResponse.trim() === '') return null;
        root = new DOMParser().parseFromString(htmlResponse, 'text/html');
      }

      const links = new Set();
      for (const anchor of root.querySelectorAll('.blog-box-layout1 a[href]')) {
        const url = new URL(anchor.getAttribute('href'), location.href);
        if (url.origin === location.origin && /^\/news\/\d+\/?$/.test(url.pathname)) {
          links.add(new URL(url.pathname.replace(/\/$/, ''), location.origin).href);
        }
      }
      if (links.size === 0) {
        throw new Error('Archive page contained no article links');
      }
      return [...links];
    }, pageNumber);
  }

  const links = new Set();
  for (let pageNumber = 1; pageNumber <= MAX_ARCHIVE_PAGES; pageNumber += 1) {
    let batch;
    for (let attempt = 1; ; attempt += 1) {
      try {
        batch = await readArchivePage(pageNumber);
        break;
      } catch (error) {
        if (attempt === 3) {
          throw new Error(`Could not read archive page ${pageNumber}`, { cause: error });
        }
        const delay = Math.max(1000, ARCHIVE_WAIT_MS) * attempt;
        console.warn(`Retrying archive page ${pageNumber} in ${delay} ms: ${error.message}`);
        await sleep(delay);
      }
    }

    if (batch === null) {
      console.log(`End of archive at page ${pageNumber}.`);
      return [...links];
    }
    for (const link of batch) links.add(link);
    console.log(`Archive page ${pageNumber}: ${links.size} unique article links.`);
    if (pageNumber < MAX_ARCHIVE_PAGES) await sleep(ARCHIVE_WAIT_MS);
  }

  console.warn(`Stopped at the configured archive page limit (${MAX_ARCHIVE_PAGES}).`);
  return [...links];
}

async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(ARTICLE_WAIT_MS);

  const data = await page.evaluate(() => {
    const titleEl =
      document.querySelector('h1') ||
      document.querySelector('article h2') ||
      document.querySelector('meta[property="og:title"]');

    let title = '';
    if (titleEl) {
      if (titleEl.tagName === 'META') {
        title = titleEl.getAttribute('content') || '';
      } else {
        title = titleEl.textContent || '';
      }
    }

    // Prefer textual nodes inside article/main containers.
    const articleRoot =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[class*="article"]') ||
      document.body;

    const clone = articleRoot.cloneNode(true);

    // Remove noisy nodes.
    clone.querySelectorAll(
      'script, style, noscript, svg, img, figure, nav, header, footer, aside, form, button, iframe'
    ).forEach((node) => node.remove());

    const text = (clone.innerText || clone.textContent || '').trim();

    return {
      title: title.trim(),
      text,
    };
  });

  const cleanedTitle = normalizeWhitespace(data.title || 'Untitled');
  const cleanedText = normalizeWhitespace(data.text || '');

  return {
    title: cleanedTitle,
    text: cleanedText,
    url,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const listPage = await context.newPage();
  const articlePage = await context.newPage();

  try {
    console.log(`Opening list page: ${START_URL}`);
    await listPage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const links = await collectArticleLinks(listPage);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(CORPUS_PATH, '', 'utf8');
    fs.writeFileSync(TITLES_PATH, '', 'utf8');

    console.log(`Found ${links.length} candidate links.`);

    let written = 0;
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      try {
        console.log(`[${i + 1}/${links.length}] Crawling: ${link}`);
        const article = await extractArticle(articlePage, link);

        if (!article.text || article.text.length < 100) {
          console.log('  Skipped (content too short / likely non-article).');
          continue;
        }

        const corpusBlock = [
          `### TITLE: ${article.title}`,
          `### URL: ${article.url}`,
          '',
          article.text,
          '',
          '-----',
          '',
        ].join('\n');

        fs.appendFileSync(CORPUS_PATH, corpusBlock, 'utf8');
        fs.appendFileSync(TITLES_PATH, `${article.title}\n`, 'utf8');
        written += 1;

        await sleep(500);
      } catch (err) {
        console.error(`  Failed to crawl ${link}: ${err.message}`);
      }
    }

    console.log(`Done. Wrote ${written} articles.`);
    console.log(`Corpus: ${CORPUS_PATH}`);
    console.log(`Titles index: ${TITLES_PATH}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
