#!/usr/bin/env node

/**
 * Muna magazine crawler
 *
 * Crawls https://gorkhapatraonline.com/publications/muna by slowly scrolling,
 * collecting article URLs that match:
 *   //a[contains(@href,'https://gorkhapatraonline.com/news/') and not(.//img)]
 *
 * Then opens each article URL, extracts title + full textual content,
 * and writes:
 *
 * 1) output/corpus.txt  -> full article texts
 * 2) output/titles.txt  -> one title per line (index)
 *
 * Usage:
 *   npm i playwright
 *   node muna_crawler.js
 *
 * Optional environment variables:
 *   START_URL=https://gorkhapatraonline.com/publications/muna
 *   MAX_SCROLL_ROUNDS=200
 *   MAX_IDLE_ROUNDS=12
 *   SCROLL_WAIT_MS=1800
 *   ARTICLE_WAIT_MS=1500
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const START_URL = process.env.START_URL || 'https://gorkhapatraonline.com/publications/muna';
const MAX_SCROLL_ROUNDS = Number(process.env.MAX_SCROLL_ROUNDS || 200);
const MAX_IDLE_ROUNDS = Number(process.env.MAX_IDLE_ROUNDS || 12);
const SCROLL_WAIT_MS = Number(process.env.SCROLL_WAIT_MS || 1800);
const ARTICLE_WAIT_MS = Number(process.env.ARTICLE_WAIT_MS || 1500);

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const CORPUS_PATH = path.join(OUTPUT_DIR, 'corpus.txt');
const TITLES_PATH = path.join(OUTPUT_DIR, 'titles.txt');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function collectArticleLinksByScrolling(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(ARTICLE_WAIT_MS);

  const linkSet = new Set();
  let idleRounds = 0;

  for (let round = 1; round <= MAX_SCROLL_ROUNDS; round += 1) {
    const newLinks = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .filter((a) => {
          const href = a.href || '';
          const matchesNews = href.includes('https://gorkhapatraonline.com/news/');
          const hasImageChild = Boolean(a.querySelector('img'));
          return matchesNews && !hasImageChild;
        })
        .map((a) => a.href);
    });

    const before = linkSet.size;
    for (const link of newLinks) linkSet.add(link);
    const after = linkSet.size;

    if (after === before) {
      idleRounds += 1;
    } else {
      idleRounds = 0;
    }

    console.log(`Scroll round ${round}: collected ${after} unique article links.`);

    // Scroll down to trigger infinite load.
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    });

    await sleep(SCROLL_WAIT_MS);

    if (idleRounds >= MAX_IDLE_ROUNDS) {
      console.log(`No new links for ${MAX_IDLE_ROUNDS} rounds. Stopping scroll.`);
      break;
    }
  }

  return Array.from(linkSet);
}

async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(ARTICLE_WAIT_MS);

  const data = await page.evaluate(() => {
    const titleEl =
      document.querySelector('article h1') ||
      document.querySelector('h1') ||
      document.querySelector('meta[property="og:title"]');

    let title = '';
    if (titleEl) {
      if (titleEl.tagName === 'META') {
        title = titleEl.getAttribute('content') || '';
      } else {
        title = titleEl.textContent || '';
      }
    }

    const articleRoot =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[class*="article"]') ||
      document.body;

    const clone = articleRoot.cloneNode(true);

    clone
      .querySelectorAll(
        'script, style, noscript, svg, img, figure, nav, header, footer, aside, form, button, iframe'
      )
      .forEach((node) => node.remove());

    const text = (clone.innerText || clone.textContent || '').trim();

    return {
      title: title.trim(),
      text,
    };
  });

  return {
    title: normalizeWhitespace(data.title || 'Untitled'),
    text: normalizeWhitespace(data.text || ''),
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
    const links = await collectArticleLinksByScrolling(listPage);

    if (!links.length) {
      console.warn('No article links found. Try increasing MAX_SCROLL_ROUNDS/MAX_IDLE_ROUNDS.');
      return;
    }

    console.log(`Found ${links.length} article links to crawl.`);

    let written = 0;
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];

      try {
        console.log(`[${i + 1}/${links.length}] Crawling: ${link}`);
        const article = await extractArticle(articlePage, link);

        if (!article.text) {
          console.log('  Skipped (empty text).');
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
