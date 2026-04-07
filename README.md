# Muna Magazine Crawler (JavaScript)

This crawler scrolls through the Muna publication listing and extracts article text into two files:

- `output/corpus.txt` – full text corpus (title, URL, and article content)
- `output/titles.txt` – one title per line (article index)

It only collects links that match the equivalent of:

```xpath
//a[contains(@href,'https://gorkhapatraonline.com/news/') and not(.//img)]
```

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
- `MAX_SCROLL_ROUNDS` (default: `200`)
- `MAX_IDLE_ROUNDS` (default: `12`)
- `SCROLL_WAIT_MS` (default: `1800`)
- `ARTICLE_WAIT_MS` (default: `1500`)

If the page loads slowly and you see too few articles, increase both
`MAX_SCROLL_ROUNDS` and `MAX_IDLE_ROUNDS`.

Example:

```bash
MAX_SCROLL_ROUNDS=400 MAX_IDLE_ROUNDS=25 SCROLL_WAIT_MS=2200 node muna_crawler.js
```
