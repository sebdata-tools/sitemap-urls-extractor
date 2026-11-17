# Sitemap URLs Extractor: Every URL, lastmod, Images, Hreflang

Give Sitemap URLs Extractor websites and get back **every URL their sitemaps list, one row per URL,
with `lastmod`, `changefreq`, `priority` and the sitemap file it came from**. It finds the sitemaps
itself (robots.txt, then the usual paths), follows sitemap indexes up to 5 levels deep, and reads XML, gzip, plain
text and RSS/Atom. Many sites in one run.

- **Many sites per run:** up to 500 websites or sitemap addresses, read 4 at a time.
- **Finds the sitemaps for you:** or give the address of one sitemap or sitemap index to read only that.
- **Filters:** keep or skip URLs by text or regular expression, and keep only URLs modified on or
  after a date ("7 days" works too, for scheduled runs).
- **Image, video, news and hreflang data** on request, as lists on each row.
- **Tolerant:** gzip recognised by its content, not its name; broken XML still gives its URLs.
- **Fast and light:** plain HTTP, no browser; files are streamed, so a sitemap of any size fits in
  512 MB. In a local test 97,334 URLs from 4 sites took 214 seconds (most of it writing rows to
  disk) with a memory peak of 179 MB.

Open source (MIT). Written in Node.js on the Apify SDK; it runs on your own machine without an Apify account.

## Run it locally

Needs Node.js 20 or later.

```
git clone https://github.com/sebdata-tools/sitemap-urls-extractor.git
cd sitemap-urls-extractor
npm install
node test/run_local.mjs @input.json
```

`input.json` is a file you write; the fields are under "Input example" below. `run_local.mjs` runs
`src/main.js` with local storage, prints a summary and the first rows, and leaves all rows in
`storage/items.json` (one file per row is in `storage/datasets/default/`). Each run wipes `storage/` first.

Where the sections below mention a price or what is charged, that applies to the hosted version only:
run locally, nothing is charged.

## Input example

```json
{
    "sites": ["https://www.sitemaps.org", "yoast.com", "https://www.mkdocs.org/sitemap.xml.gz"],
    "maxUrlsPerSite": 5000,
    "includePatterns": ["/blog/", "\\.html$"],
    "excludePatterns": ["/tag/"],
    "modifiedAfter": "2026-01-01",
    "includeExtensions": false
}
```

| Field | What it does | Default |
|---|---|---|
| `sites` | Websites (`example.com`, `https://www.example.com`) or direct sitemap addresses. An address is read as a sitemap when its path ends in `.xml`, `.xml.gz` or `.txt`, or contains `sitemap`. Up to 500. Required. | |
| `maxUrlsPerSite` | Stop after this many saved URLs per entry of `sites`; no further sitemap files are fetched. `0` = no limit. | `10000` |
| `includePatterns` | Keep a URL only if it matches at least one. Each pattern is text the URL must contain, or a regular expression. Case-sensitive. | none |
| `excludePatterns` | Drop a URL if it matches any. Applied after `includePatterns`. | none |
| `modifiedAfter` | Keep only URLs whose `lastmod` is on or after this: `2026-01-31`, `2026-01-31T12:00:00Z`, or an age such as `7 days`, `2 weeks`, `3 months`. See "Dates" below. | none |
| `includeExtensions` | Add `images`, `videos`, `news` and `alternates` (hreflang) to the rows whose sitemap entry has them. | `false` |
| `proxyConfiguration` | Optional proxy. Usually not needed. | none |

## Output example

A row, as saved from `https://www.learnenough.com/sitemap.txt` (which is gzipped XML despite its name):

```json
{
    "url": "https://www.learnenough.com/blog",
    "lastmod": "2024-02-22T02:01:21.000Z",
    "changefreq": "weekly",
    "priority": 0.8,
    "sitemapUrl": "https://www.learnenough.com/sitemap.txt",
    "site": "https://www.learnenough.com/sitemap.txt"
}
```

With `includeExtensions` on, from a Shopify store given as `www.deathwishcoffee.com`:

```json
{
    "url": "https://www.deathwishcoffee.com/products/valhalla-java-single-serve-pods",
    "lastmod": "2026-11-14T08:11:24.000Z",
    "changefreq": "daily",
    "priority": null,
    "sitemapUrl": "https://www.deathwishcoffee.com/sitemap_products_1.xml?from=171104582&to=15420124135479",
    "site": "www.deathwishcoffee.com",
    "images": [
        {
            "url": "https://cdn.shopify.com/s/files/1/0271/7209/files/Valhalla_Java_10ct_Angle_Vertical_Pods_A1_2.jpg?v=1733925456",
            "title": "Valhalla Java Single-Serve Pods",
            "caption": "Death Wish Coffee 10 Count Valhalla Java Single-Serve Pods."
        }
    ]
}
```

| Field | Meaning |
|---|---|
| `url` | The page address as the sitemap gives it (XML entities decoded, relative addresses resolved). |
| `lastmod` | A date (`2026-01-31`) when the sitemap gives no time, otherwise ISO 8601 in UTC. `null` when absent or unreadable. |
| `changefreq`, `priority` | The sitemap's hints, `null` when absent. |
| `sitemapUrl` | The sitemap file the URL was read from. |
| `site` | The entry of `sites` it belongs to, as you typed it. |
| `images` | `url`, `title`, `caption`. |
| `videos` | `title`, `description`, `thumbnailUrl`, `contentUrl`, `playerUrl`, `durationSeconds`, `publicationDate`. |
| `news` | `title`, `publicationName`, `language`, `publicationDate`. |
| `alternates` | `hreflang`, `href`. |

The four lists appear only with `includeExtensions`, and only on rows that have them; empty fields
inside them are left out. Export the dataset as JSON, CSV or Excel, or read it through the Apify API.

## How discovery works

For a website:

1. `robots.txt` is read and every `Sitemap:` line is followed (they may point to another host).
2. If robots.txt names none (or none of those could be read), these addresses are tried in order
   and the first that is a sitemap is used: `/sitemap.xml`, `/sitemap_index.xml`,
   `/sitemap-index.xml`, `/sitemap.txt`, `/wp-sitemap.xml`.
3. Sitemap indexes are followed, index inside index up to 5 levels, each file once (so a sitemap that
   lists itself cannot loop), up to 5,000 sitemap files per site.

For a direct sitemap address only that file is read, plus the files it lists if it is an index.

What it reads: XML sitemaps and indexes with any namespace prefix, with or without an XML
declaration, a byte-order mark or CDATA; gzip files (recognised by their first bytes, so a
mislabelled `.txt` or `.xml` works, and so does a plain file named `.gz`); text sitemaps with one URL
per line; RSS and Atom feeds listed as sitemaps (the item link and its date). XML is not parsed
strictly: an entry with a missing closing tag, a bare `&`, junk before the declaration or a file cut
off in the middle still gives its URLs. A download that breaks off is restarted up to twice and
carries on where it stopped.

Each URL is saved once per site, the first time it is seen, even if several sitemaps list it.

## Dates: `lastmod` and `modifiedAfter`

- A `lastmod` without a time covers its whole day: with `modifiedAfter` `2026-01-31T12:00:00Z`, a
  URL dated `2026-01-31` is kept. A time without a zone is read as UTC.
- **URLs without a `lastmod` are dropped when `modifiedAfter` is set.** The filter means "known to
  have changed since"; a URL with no date cannot show that. They are counted in `urlsFilteredOut`.
- **Child sitemaps that an index dates before `modifiedAfter` are not fetched** (counted in
  `sitemapFilesSkippedOld`). This saves most of the requests on large sites, and relies on the
  site's index dates being right. Child sitemaps without a date in the index are always read.
- An age (`7 days`) is counted back from the start of the run; a month is 30 days, a year 365.

## The run summary

The key-value store record `SUMMARY` has the totals, the peak memory, and one `siteReport` entry
per input:

```json
{
    "input": "yoast.com",
    "status": "ok",
    "discovery": "robots",
    "sitemapsFound": 1,
    "sitemapFilesRead": 22,
    "sitemapFilesFailed": 0,
    "sitemapFilesSkippedOld": 0,
    "sitemapFilesSkipped": 0,
    "urlsFound": 2646,
    "urlsSaved": 2524,
    "urlsFilteredOut": 0,
    "duplicates": 122,
    "entriesInvalid": 0
}
```

- `discovery`: how the sitemaps were found: `robots`, `guess` (one of the usual paths) or `direct`.
  `sitemapsFound` counts the starting sitemaps; `sitemapFilesRead` counts every file, indexes included.
- `status`: `ok`; `partial` (some sitemap files failed, the site started refusing requests, or the
  5,000-file or 5-level limit was hit; `failedFiles` lists failed files with reasons); `no_sitemap`; `blocked` (the site answers 401, 403 or 429);
  `unreachable` (no answer, for example a domain that does not exist); `error`. A `message` says
  what happened in words.
- `entriesInvalid`: sitemap entries without a usable address.

Sites that give nothing are reported here and in the log, are not charged, and do not fail the run.
The run fails only on invalid input, or when not a single site could be read.

## Limits

- 500 sites per run; 5,000 sitemap files and 5 index levels per site; a single sitemap is read up to
  300 MB uncompressed (the standard allows 50 MB).
- **The filters do not cap the reading.** `maxUrlsPerSite` counts saved URLs, so with narrow filters
  on a very large site the Actor may read many sitemap files to find them.
- Only what the sitemaps list: pages a site leaves out of its sitemaps are not found, and no page is
  opened. `lastmod`, `changefreq` and `priority` are the site's own claims.
- Polite by design: at most 2 sitemap files of a site at a time with a short pause between files,
  retries with backoff, and after 3 refusals in a row (401, 403, 429) the site is left alone and
  reported as `blocked`. Sites behind a browser check (a "Just a moment..." page) are reported, not
  worked around; a proxy in the input sometimes helps.
- Duplicates are detected with a 53-bit fingerprint of the URL instead of the URL itself, to keep
  memory flat on sites with millions of URLs. Two different URLs sharing a fingerprint is possible
  in theory (about 1 chance in 18,000 across a million URLs of one site); one of them would then be counted as
  a duplicate.
- Text encodings other than UTF-8 and UTF-16 are read as UTF-8; addresses are plain ASCII in
  practice, so this rarely matters.
- **Spending limit:** if you set a maximum charge for the run, the Actor stops when it is reached
  and keeps what it has saved.
- Only public sitemap files are read: no login, no personal data.

## Typical uses

A URL list for a crawler or scraper, content audits and migrations, finding new or recently changed
pages (schedule a run with `modifiedAfter: "1 day"`), competitor content monitoring, checking a
site's own sitemaps for gaps and duplicates, hreflang and image-sitemap audits, feeding a site's
pages to an LLM or agent.

## Tests

`src/lib.js` holds the pure logic (input checks, URL building, parsing); `src/main.js` holds the network
and storage code. The unit tests in `test/lib.test.js` run `lib.js` against saved answers of the live
sources. Those files are copies of third-party pages and API answers and are **not included in this
repository**, so `npm test` says so and skips. To run them, save your own captures under `test/fixtures/`
with the file names the test reads. The live check is `node test/run_local.mjs @input.json`.

## Hosted version

To run it in the cloud, on a schedule or through an API, without installing anything: [Sitemap URLs Extractor: Every URL, lastmod, Images, Hreflang on Apify](https://apify.com/sebdata/sitemap-urls-extractor) (paid per result).

## Who made this

This tool and its code were written by an AI agent (Anthropic's Claude), under a human account owner. Problems and wrong results: open an issue. MIT licence, no warranty.
