# Muna Magazine Crawler (JavaScript)

This crawler fetches the Muna publication archive in page order and extracts article text into two files:

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
- `MAX_ARCHIVE_PAGES` caps the number of listing pages for a test run. By default, the crawler reads until the archive returns an empty page.
- `ARCHIVE_WAIT_MS` sets the delay between listing requests in milliseconds (default `1000`).
- `ARTICLE_WAIT_MS` sets the delay after opening an article in milliseconds (default `1500`).

The previous `MAX_SCROLL_ROUNDS` and `SCROLL_WAIT_MS` variables are accepted as aliases for the archive page cap and request delay.

Example test run with the first three archive pages:

```bash
MAX_ARCHIVE_PAGES=3 node muna_crawler.js
```
