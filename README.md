# Muna Magazine Crawler (JavaScript)

This crawler scrolls through the Muna publication listing and extracts article text into two files:

- `output/corpus.txt` – full text corpus (title, URL, and article content)
- `output/titles.txt` – one title per line (article index)

## Link collection rule

The crawler collects links using this XPath-equivalent Playwright locator:

```xpath
//a[contains(@href,'https://gorkhapatraonline.com/news/') and not(.//img)]
```

Then, during article extraction, it applies an extra Muna-check and skips non-Muna pages.

## Setup

```bash
npm init -y
npm i playwright
```

## Run

```bash
node muna_crawler.js
```

## Optional environment variables

- `START_URL` (default: `https://gorkhapatraonline.com/publications/muna`)
- `MAX_SCROLL_ROUNDS` (default: `300`)
- `MAX_IDLE_ROUNDS` (default: `20`)
- `SCROLL_WAIT_MS` (default: `2200`)
- `ARTICLE_WAIT_MS` (default: `1600`)

If you still get too few links/articles, increase:
- `MAX_SCROLL_ROUNDS`
- `MAX_IDLE_ROUNDS`
- `SCROLL_WAIT_MS`

Example:

```bash
MAX_SCROLL_ROUNDS=500 MAX_IDLE_ROUNDS=30 SCROLL_WAIT_MS=2800 node muna_crawler.js
```
