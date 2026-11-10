#!/usr/bin/env node

/**
 * Muna magazine crawler
 *
 * Crawls https://gorkhapatraonline.com/publications/muna by slowly scrolling,
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
 *   MAX_SCROLL_ROUNDS=40     (default: 40)
 *   SCROLL_WAIT_MS=1800      (default: 1800)
 *   ARTICLE_WAIT_MS=1500     (default: 1500)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const START_URL = process.env.START_URL || 'https://gorkhapatraonline.com/publications/muna';
const MAX_SCROLL_ROUNDS = Number(process.env.MAX_SCROLL_ROUNDS || 40);
const SCROLL_WAIT_MS = Number(process.env.SCROLL_WAIT_MS || 1800);
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

function uniquePreserveOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

async function collectArticleLinks(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(ARTICLE_WAIT_MS);

  let previousCount = 0;
  let stableRounds = 0;

  for (let round = 1; round <= MAX_SCROLL_ROUNDS; round += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
    });

    await sleep(SCROLL_WAIT_MS);

    const currentCount = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .map((a) => a.href)
        .filter((href) => /gorkhapatraonline\.com\/.+/.test(href) && !href.includes('#')).length;
    });

    if (currentCount === previousCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      previousCount = currentCount;
    }

    // If no new links have appeared in several rounds, assume we've reached end.
    if (stableRounds >= 4) {
      break;
    }
  }

  const rawLinks = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors
      .map((a) => a.href)
      .filter((href) => {
        if (!href) return false;
        if (!href.includes('gorkhapatraonline.com')) return false;
        if (href.includes('/publications/muna')) return false;
        if (href.includes('/tag/')) return false;
        if (href.includes('/author/')) return false;
        if (href.includes('/category/')) return false;
        return true;
      });
  });

  return uniquePreserveOrder(rawLinks);
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
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(CORPUS_PATH, '', 'utf8');
  fs.writeFileSync(TITLES_PATH, '', 'utf8');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const listPage = await context.newPage();
  const articlePage = await context.newPage();

  try {
    console.log(`Opening list page: ${START_URL}`);
    const links = await collectArticleLinks(listPage);

    if (!links.length) {
      console.warn('No candidate links found. Consider increasing MAX_SCROLL_ROUNDS.');
      return;
    }

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
