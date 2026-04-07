# Muna Magazine Crawler (JavaScript)

This crawler scrolls through the Muna publication listing and extracts article text into two files:

- `output/corpus.txt` – full text corpus (title, URL, and article content)
- `output/titles.txt` – one title per line (article index)

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
- `MAX_SCROLL_ROUNDS` (default: `40`)
- `SCROLL_WAIT_MS` (default: `1800`)
- `ARTICLE_WAIT_MS` (default: `1500`)

Example:

```bash
MAX_SCROLL_ROUNDS=60 SCROLL_WAIT_MS=2500 node muna_crawler.js
```
