#!/usr/bin/env node

/**
 * Muna magazine crawler
 *
 * Crawls https://gorkhapatraonline.com/publications/muna by scrolling and collecting
 * article URLs from anchors that match:
 *   //a[contains(@href,'https://gorkhapatraonline.com/news/') and not(.//img)]
 *
 * Then visits each URL, keeps only Muna-related articles, extracts title + full text,
 * and writes:
 *   - output/corpus.txt
 *   - output/titles.txt
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const START_URL = process.env.START_URL || 'https://gorkhapatraonline.com/publications/muna';
const MAX_SCROLL_ROUNDS = Number(process.env.MAX_SCROLL_ROUNDS || 300);
const MAX_IDLE_ROUNDS = Number(process.env.MAX_IDLE_ROUNDS || 20);
const SCROLL_WAIT_MS = Number(process.env.SCROLL_WAIT_MS || 2200);
const ARTICLE_WAIT_MS = Number(process.env.ARTICLE_WAIT_MS || 1600);

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const CORPUS_PATH = path.join(OUTPUT_DIR, 'corpus.txt');
const TITLES_PATH = path.join(OUTPUT_DIR, 'titles.txt');

const LINK_XPATH = "//a[contains(@href,'https://gorkhapatraonline.com/news/') and not(.//img)]";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function maybeClickLoadMore(page) {
  const selectors = [
    'button:has-text("Load More")',
    'button:has-text("load more")',
    'a:has-text("Load More")',
    '[role="button"]:has-text("Load More")',
  ];

  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.count()) {
      try {
        if (await el.isVisible()) {
          await el.click({ timeout: 2000 });
          await sleep(900);
          return true;
        }
      } catch (err) {
        // ignore and continue
      }
    }
  }

  return false;
}

async function collectArticleLinksByScrolling(page) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(ARTICLE_WAIT_MS);

  const linkSet = new Set();
  let idleRounds = 0;

  for (let round = 1; round <= MAX_SCROLL_ROUNDS; round += 1) {
    const newLinks = await page.locator(`xpath=${LINK_XPATH}`).evaluateAll((nodes) =>
      nodes
        .map((node) => node.href)
        .filter((href) => href && href.startsWith('https://gorkhapatraonline.com/news/'))
    );

    const before = linkSet.size;
    for (const link of newLinks) linkSet.add(link.split('?')[0]);

    const prevHeight = await page.evaluate(() => document.body.scrollHeight);

    // Scroll all the way to bottom to trigger infinite loading.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(SCROLL_WAIT_MS);

    // Some sites require a click on load-more style controls.
    await maybeClickLoadMore(page);

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    const after = linkSet.size;

    const noNewLinks = after === before;
    const noHeightGrowth = currentHeight <= prevHeight;

    if (noNewLinks && noHeightGrowth) {
      idleRounds += 1;
    } else {
      idleRounds = 0;
    }

    console.log(
      `Scroll ${round}: links=${after}, pageHeight=${currentHeight}, idle=${idleRounds}/${MAX_IDLE_ROUNDS}`
    );

    if (idleRounds >= MAX_IDLE_ROUNDS) {
      console.log('Reached stable end of infinite scroll.');
      break;
    }
  }

  return Array.from(linkSet);
}

async function isMunaArticle(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const munaInPage = text.includes('muna') || text.includes('मुना');

    const munaLinkPresent = Array.from(document.querySelectorAll('a[href]')).some((a) =>
      (a.getAttribute('href') || '').includes('/publications/muna')
    );

    return munaInPage || munaLinkPresent;
  });
}

async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(ARTICLE_WAIT_MS);

  const munaArticle = await isMunaArticle(page);
  if (!munaArticle) {
    return null;
  }

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

  const cleanTitle = normalizeWhitespace(data.title || 'Untitled');
  const cleanText = normalizeWhitespace(data.text || '');

  if (!cleanText) {
    return null;
  }

  return {
    title: cleanTitle,
    text: cleanText,
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
      console.warn('No candidate links found from the Muna listing.');
      return;
    }

    console.log(`Collected ${links.length} candidate article links.`);

    let written = 0;
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      try {
        console.log(`[${i + 1}/${links.length}] Crawling: ${link}`);
        const article = await extractArticle(articlePage, link);
        if (!article) {
          console.log('  Skipped (not Muna article or empty content).');
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
        await sleep(400);
      } catch (err) {
        console.error(`  Failed ${link}: ${err.message}`);
      }
    }

    console.log(`Done. Wrote ${written} Muna articles.`);
    console.log(`Corpus: ${CORPUS_PATH}`);
    console.log(`Title index: ${TITLES_PATH}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
