#!/usr/bin/env node

/**
 * Muna magazine crawler.
 *
 * What it does:
 * 1) Opens https://gorkhapatraonline.com/publications/muna
 * 2) Slowly scrolls to trigger infinite loading
 * 3) Collects article URLs
 * 4) Opens every article and extracts title + full textual content
 * 5) Writes:
 *    - corpus.txt (all article texts)
 *    - titles_index.txt (one title per line, in crawl order)
 *
 * Usage:
 *   npm i puppeteer
 *   node muna_crawler.js
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const START_URL = 'https://gorkhapatraonline.com/publications/muna';
const OUT_DIR = path.resolve(process.cwd(), 'output');
const CORPUS_FILE = path.join(OUT_DIR, 'corpus.txt');
const TITLES_FILE = path.join(OUT_DIR, 'titles_index.txt');

const CONFIG = {
  maxScrollRounds: 120,
  scrollPauseMs: 1800,
  maxStagnantRounds: 8,
  articleLoadTimeoutMs: 45_000,
  retryPerArticle: 2,
};

function ensureOutputFiles() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CORPUS_FILE, '', 'utf8');
  fs.writeFileSync(TITLES_FILE, '', 'utf8');
}

function appendArticleToFiles(index, url, title, content) {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const cleanContent = content.replace(/\n{3,}/g, '\n\n').trim();

  const block = [
    `===== ARTICLE ${index} =====`,
    `URL: ${url}`,
    `TITLE: ${cleanTitle}`,
    '',
    cleanContent,
    '',
    '===== END ARTICLE =====',
    '',
  ].join('\n');

  fs.appendFileSync(CORPUS_FILE, block, 'utf8');
  fs.appendFileSync(TITLES_FILE, `${index}. ${cleanTitle}\n`, 'utf8');
}

function normalizeWhitespace(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// `page.waitForTimeout()` was removed in newer Puppeteer releases. Keeping the
// delay independent of Puppeteer's Page API makes this script work with both
// older and current versions.
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectArticleLinks(page) {
  const links = new Set();
  let stagnantRounds = 0;

  for (let i = 0; i < CONFIG.maxScrollRounds; i++) {
    const before = links.size;

    const foundLinks = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href]')];
      const urlList = [];

      for (const a of anchors) {
        const raw = a.getAttribute('href') || '';
        if (!raw) continue;

        let abs;
        try {
          abs = new URL(raw, location.origin).toString();
        } catch {
          continue;
        }

        if (!abs.startsWith('https://gorkhapatraonline.com/')) continue;
        if (abs.includes('/publications/muna')) continue;

        // Keep only likely article pages.
        if (!/\/(news|article|story)\//i.test(abs)) continue;

        urlList.push(abs.split('#')[0]);
      }

      return [...new Set(urlList)];
    });

    for (const link of foundLinks) links.add(link);

    const after = links.size;
    if (after === before) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
    }

    if (stagnantRounds >= CONFIG.maxStagnantRounds) {
      console.log(`Stopping scroll after ${i + 1} rounds (no new links).`);
      break;
    }

    await page.evaluate(() => {
      window.scrollBy({ top: Math.floor(window.innerHeight * 0.9), behavior: 'smooth' });
    });

    await sleep(CONFIG.scrollPauseMs);
    console.log(`Scroll round ${i + 1}: collected ${links.size} candidate links.`);
  }

  return [...links];
}

async function extractArticle(page) {
  return page.evaluate(() => {
    const titleCandidates = [
      document.querySelector('article h1'),
      document.querySelector('main h1'),
      document.querySelector('h1'),
    ].filter(Boolean);

    const metaTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
    const title = titleCandidates[0]?.textContent?.trim() || metaTitle || 'Untitled';

    const bodySelectors = [
      'article',
      '.article-body',
      '.news-content',
      '.post-content',
      '.entry-content',
      'main',
    ];

    let bodyRoot = null;
    for (const sel of bodySelectors) {
      const el = document.querySelector(sel);
      if (el) {
        bodyRoot = el;
        break;
      }
    }

    const root = bodyRoot || document.body;

    // Remove non-textual or irrelevant areas from clone.
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, figure, img, svg, video, audio, iframe, nav, footer, header, aside, .advertisement, .social-share').forEach((el) => el.remove());

    let paragraphs = [...clone.querySelectorAll('p')]
      .map((p) => p.textContent?.trim())
      .filter(Boolean);

    // Fallback: if not enough paragraphs found, take all text blocks.
    if (paragraphs.length < 2) {
      const text = clone.innerText || '';
      paragraphs = text
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    const content = paragraphs.join('\n\n').trim();

    return { title, content };
  });
}

async function crawl() {
  ensureOutputFiles();

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1366, height: 850 },
  });

  try {
    const listPage = await browser.newPage();
    listPage.setDefaultNavigationTimeout(CONFIG.articleLoadTimeoutMs);

    console.log(`Opening: ${START_URL}`);
    await listPage.goto(START_URL, { waitUntil: 'networkidle2' });

    const articleLinks = await collectArticleLinks(listPage);
    console.log(`Total candidate article links: ${articleLinks.length}`);

    const seenTitles = new Set();
    let savedCount = 0;

    for (const url of articleLinks) {
      let success = false;

      for (let attempt = 1; attempt <= CONFIG.retryPerArticle + 1; attempt++) {
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(CONFIG.articleLoadTimeoutMs);

        try {
          console.log(`Fetching (${attempt}/${CONFIG.retryPerArticle + 1}): ${url}`);
          await page.goto(url, { waitUntil: 'networkidle2' });
          await sleep(700);

          const { title, content } = await extractArticle(page);
          const cleanTitle = normalizeWhitespace(title);
          const cleanContent = normalizeWhitespace(content);

          if (!cleanTitle || !cleanContent || cleanContent.length < 100) {
            throw new Error('Article text too short or empty after extraction');
          }

          if (seenTitles.has(cleanTitle)) {
            console.log(`Skipping duplicate title: ${cleanTitle}`);
            success = true;
            break;
          }

          savedCount += 1;
          seenTitles.add(cleanTitle);
          appendArticleToFiles(savedCount, url, cleanTitle, cleanContent);
          console.log(`Saved #${savedCount}: ${cleanTitle}`);

          success = true;
          break;
        } catch (err) {
          console.error(`Failed on ${url} (attempt ${attempt}): ${err.message}`);
        } finally {
          await page.close();
        }
      }

      if (!success) {
        console.warn(`Giving up on URL: ${url}`);
      }
    }

    console.log('\nDone.');
    console.log(`Articles written: ${savedCount}`);
    console.log(`Corpus file: ${CORPUS_FILE}`);
    console.log(`Title index: ${TITLES_FILE}`);
  } finally {
    await browser.close();
  }
}

crawl().catch((err) => {
  console.error('Crawler crashed:', err);
  process.exit(1);
});
