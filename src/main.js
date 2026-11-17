// Sitemap URLs Extractor: finds the sitemaps of many websites (robots.txt, then the usual paths), follows
// sitemap indexes and saves one row per URL. Files are streamed and rows are pushed as they are read.
import { Readable, pipeline } from 'node:stream';
import zlib from 'node:zlib';

import { Actor, log } from 'apify';
import { ProxyAgent, fetch } from 'undici';

import { GUESS_PATHS, InputError, SitemapScanner, hashUrl, isOnOrAfter, normalizeInput, parseRobots, passesPatterns, toRow } from './lib.js';

const EVENT = 'url';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
const RETRIES = 3;
const HEADERS_TIMEOUT_MS = 30_000; // until the response starts
const BODY_TIMEOUT_MS = 240_000; // for the whole file
const SITE_CONCURRENCY = 4;
const FILE_CONCURRENCY = 2; // sitemap files of one site read at the same time
const FILE_DELAY_MS = 150; // pause before the next file of the same site
const MAX_DEPTH = 5; // index inside index inside index...
const MAX_FILES_PER_SITE = 5000;
const MAX_FILE_BYTES = 300 * 1024 * 1024; // uncompressed; the standard allows 50 MB
const MAX_ROBOTS_CHARS = 1_000_000;
const BATCH = 500; // rows per push
const READ_AHEAD_CHARS = 8_000_000; // how far a download may run ahead of the processing, per file
const BODY_RETRIES = 2; // fresh starts for a download that breaks off in the middle
const BLOCKED_STREAK = 3; // this many refusals in a row and the site is left alone
const MAX_FAILED_LISTED = 20;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isRefusal = (status) => status === 401 || status === 403 || status === 429;

/** A network error in words: undici hides the reason in `cause`. */
function reason(err) {
    if (err.status) return `HTTP ${err.status}`;
    const code = err.cause?.code ?? err.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the domain does not resolve (DNS)';
    if (code === 'ECONNREFUSED') return 'connection refused';
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || err.name === 'TimeoutError' || err.message === 'timeout') return 'timed out';
    if (code) return `${code}${err.cause?.message ? `: ${err.cause.message}` : ''}`;
    return err.cause?.message ?? err.message;
}

/**
 * GET with retries and backoff on network errors, 429 and 5xx (honours Retry-After).
 * Returns { res, done }: the caller reads res.body and must call done(). Other 4xx throw with `.status`.
 */
async function open(url, retries = RETRIES) {
    let lastError;
    let wait = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(Math.max(wait, Math.min(1000 * 2 ** (attempt - 1), 15_000)) + Math.random() * 500);
        wait = 0;
        const controller = new AbortController();
        let timer = setTimeout(() => controller.abort(new Error('timeout')), HEADERS_TIMEOUT_MS);
        try {
            stats.requests++;
            const res = await fetch(url, {
                dispatcher,
                headers: { 'user-agent': USER_AGENT, accept: 'application/xml,text/xml,text/plain,application/x-gzip,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.8' },
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (res.status === 429 || res.status >= 500) {
                await res.body?.cancel().catch(() => {});
                const retryAfter = Number(res.headers.get('retry-after'));
                if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(retryAfter * 1000, 30_000);
                lastError = new Error(`HTTP ${res.status}`);
                lastError.status = res.status;
                continue;
            }
            if (!res.ok) {
                await res.body?.cancel().catch(() => {});
                const err = new Error(`HTTP ${res.status}`);
                err.permanent = true;
                err.status = res.status;
                throw err;
            }
            stats.responses++;
            timer = setTimeout(() => controller.abort(new Error('timeout')), BODY_TIMEOUT_MS);
            return { res, done: () => { clearTimeout(timer); controller.abort(); } };
        } catch (err) {
            clearTimeout(timer);
            if (err.permanent) throw err;
            lastError = err;
            const code = err.cause?.code;
            if (code === 'ENOTFOUND' || code === 'ERR_INVALID_URL') break; // no point asking again
        }
    }
    throw lastError;
}

/** Unwraps gzip when the data starts with the gzip magic bytes, whatever the file is called (twice at most). */
async function gunzipIfNeeded(readable, depth = 0) {
    const it = readable[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    let ended = false;
    while (head.length < 2) {
        const { value, done } = await it.next();
        if (done) {
            ended = true;
            break;
        }
        head = Buffer.concat([head, value]);
    }
    const rest = Readable.from((async function* () {
        try {
            if (head.length) yield head;
            while (!ended) {
                const { value, done } = await it.next();
                if (done) return;
                yield value;
            }
        } finally {
            await it.return?.();
        }
    })(), { objectMode: false });
    if (depth < 2 && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
        const gunzip = zlib.createGunzip();
        pipeline(rest, gunzip, () => {});
        return gunzipIfNeeded(gunzip, depth + 1);
    }
    return rest;
}

/** The response body as text, piece by piece: gzip unwrapped, UTF-8 or UTF-16 (by byte-order mark), size-capped. */
async function* textChunks(res, info) {
    if (!res.body) return;
    const source = await gunzipIfNeeded(Readable.fromWeb(res.body));
    source.on('error', () => {});
    let decoder = null;
    let bytes = 0;
    for await (const chunk of source) {
        if (!decoder) {
            let encoding = 'utf-8';
            if (chunk[0] === 0xff && chunk[1] === 0xfe) encoding = 'utf-16le';
            else if (chunk[0] === 0xfe && chunk[1] === 0xff) encoding = 'utf-16be';
            decoder = new TextDecoder(encoding);
        }
        bytes += chunk.length;
        if (bytes > MAX_FILE_BYTES) {
            info.truncated = true;
            break;
        }
        yield decoder.decode(chunk, { stream: true });
    }
    if (decoder) yield decoder.decode();
}

/**
 * Lets the download run ahead of the processing by up to `maxChars`, so that a slow dataset write does not
 * stall the connection (some servers drop a stalled download). Pieces come out in order; an error comes out
 * after the pieces received before it.
 */
async function* readAhead(source, maxChars) {
    const queue = [];
    let size = 0;
    let finished = false;
    let quit = false;
    let error = null;
    let wake = null; // the consumer waiting for a piece
    let room = null; // the producer waiting for room
    (async () => {
        try {
            for await (const text of source) {
                if (quit) break;
                queue.push(text);
                size += text.length;
                wake?.();
                if (size > maxChars) await new Promise((resolve) => { room = resolve; });
                if (quit) break;
            }
        } catch (err) {
            error = err;
        } finally {
            finished = true;
            wake?.();
        }
    })();
    try {
        for (;;) {
            if (queue.length > 0) {
                const text = queue.shift();
                size -= text.length;
                if (size <= maxChars && room) {
                    room();
                    room = null;
                }
                yield text;
            } else if (error) {
                throw error;
            } else if (finished) {
                return;
            } else {
                await new Promise((resolve) => { wake = resolve; });
                wake = null;
            }
        }
    } finally {
        quit = true;
        room?.();
    }
}

const stats = { sites: 0, sitesOk: 0, sitesFailed: 0, requests: 0, responses: 0, sitemapFiles: 0, urls: 0 };

await Actor.init();

let input;
try {
    input = normalizeInput(await Actor.getInput());
} catch (err) {
    if (err instanceof InputError) await Actor.fail(`Invalid input: ${err.message}`);
    throw err;
}
stats.sites = input.targets.length;

const proxyConfiguration = input.proxyConfiguration ? await Actor.createProxyConfiguration(input.proxyConfiguration) : undefined;
const proxyUrl = await proxyConfiguration?.newUrl();
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const chargingManager = Actor.getChargingManager();
const remainingBudget = () => {
    const n = chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT);
    return Number.isFinite(n) ? n : Infinity;
};

let limitReached = false;
let pushing = Promise.resolve(); // pushes run one at a time so the spending limit is checked between them
const report = [];

/** Saves rows, never more than the spending limit pays for. Returns how many were saved. */
function pushLimited(items) {
    const job = pushing.then(async () => {
        if (limitReached || items.length === 0) return 0;
        const budget = remainingBudget();
        const batch = items.length > budget ? items.slice(0, budget) : items;
        if (batch.length < items.length) limitReached = true;
        if (batch.length === 0) return 0;
        const charge = await Actor.pushData(batch, EVENT);
        if (charge?.eventChargeLimitReached) limitReached = true;
        stats.urls += batch.length;
        return batch.length;
    });
    pushing = job.catch(() => {});
    return job;
}

const stopped = (ctx) => limitReached || ctx.full || ctx.blocked;

function noteFailure(ctx, url, err) {
    const { entry } = ctx;
    entry.sitemapFilesFailed++;
    if (entry.failedFiles.length < MAX_FAILED_LISTED) entry.failedFiles.push({ url, reason: typeof err === 'string' ? err : reason(err) });
}

function noteStatus(ctx, status) {
    if (isRefusal(status)) {
        ctx.refusals++;
        if (++ctx.refusalStreak >= BLOCKED_STREAK) ctx.blocked = true;
    } else {
        ctx.refusalStreak = 0;
    }
}

/** Adds a child sitemap named by an index to the site's queue, unless a limit or the date filter says no. */
function enqueue(ctx, rec, depth) {
    const { entry } = ctx;
    if (ctx.seenFiles.has(rec.url)) return; // loop protection, and the same file listed twice
    if (depth > MAX_DEPTH) {
        entry.sitemapFilesSkipped++;
        ctx.notes.add(`sitemap indexes nested deeper than ${MAX_DEPTH} levels were not followed`);
        return;
    }
    if (ctx.seenFiles.size >= MAX_FILES_PER_SITE) {
        entry.sitemapFilesSkipped++;
        ctx.notes.add(`only the first ${MAX_FILES_PER_SITE} sitemap files were read`);
        return;
    }
    if (input.modifiedAfter !== null && rec.date && !isOnOrAfter(rec.date, input.modifiedAfter)) {
        entry.sitemapFilesSkippedOld++; // the index says nothing in it changed since the cut-off
        return;
    }
    ctx.seenFiles.add(rec.url);
    ctx.queue.push({ url: rec.url, depth });
}

/**
 * Reads one sitemap file as a stream and pushes its rows as it goes.
 * `probe`: a guessed address; when it is missing or not a sitemap that is not counted as a failure.
 * Returns true when the file was a sitemap.
 */
async function readSitemap(ctx, file, probe = false) {
    const { entry, target } = ctx;
    const info = { truncated: false };
    let batch = [];
    let handled = 0; // entries of this file dealt with so far
    let skip = 0; // on a second attempt: the entries the first attempt already dealt with
    const flush = async () => {
        if (batch.length === 0) return;
        const rows = batch;
        batch = [];
        const saved = await pushLimited(rows); // not "+= await": two files of a site are read at the same time
        entry.urlsSaved += saved;
    };
    const take = (records) => {
        for (const rec of records) {
            if (skip > 0) {
                skip--;
                continue;
            }
            if (rec.type === 'sitemap') {
                handled++;
                enqueue(ctx, rec, file.depth + 1);
                continue;
            }
            if (ctx.full) return;
            handled++;
            entry.urlsFound++;
            if (input.modifiedAfter !== null && !isOnOrAfter(rec.date, input.modifiedAfter)) {
                entry.urlsFilteredOut++;
                continue;
            }
            if (!passesPatterns(rec.url, input.include, input.exclude)) {
                entry.urlsFilteredOut++;
                continue;
            }
            const key = hashUrl(rec.url);
            if (ctx.seenUrls.has(key)) {
                entry.duplicates++;
                continue;
            }
            ctx.seenUrls.add(key);
            batch.push(toRow(rec, file.url, target.source));
            if (input.maxUrlsPerSite > 0 && ++ctx.accepted >= input.maxUrlsPerSite) {
                ctx.full = true;
                return;
            }
        }
    };

    // A download that breaks off in the middle is started again (BODY_RETRIES times) and carries on after the
    // entries already dealt with, so nothing is saved or counted twice.
    let scanner;
    let bodyError;
    for (let attempt = 0; ; attempt++) {
        let handle;
        bodyError = null;
        try {
            handle = await open(file.url, probe || attempt > 0 ? 1 : RETRIES);
        } catch (err) {
            if (attempt > 0) {
                bodyError = err;
                break;
            }
            noteStatus(ctx, err.status);
            if (!probe) noteFailure(ctx, file.url, err);
            else if (!err.status || isRefusal(err.status) || err.status >= 500) ctx.probeErrors.push(`${new URL(file.url).pathname}: ${reason(err)}`);
            return false;
        }
        noteStatus(ctx, handle.res.status);
        scanner = new SitemapScanner(file.url, { extensions: input.includeExtensions });
        skip = handled;
        try {
            let cut = false;
            for await (const text of readAhead(textChunks(handle.res, info), READ_AHEAD_CHARS)) {
                take(scanner.push(text));
                if (batch.length >= BATCH) await flush();
                if (scanner.kind === 'html' || stopped(ctx)) {
                    cut = true;
                    break;
                }
            }
            if (!cut) take(scanner.end());
        } catch (err) {
            bodyError = err;
        } finally {
            handle.done();
        }
        await flush();
        if (!bodyError || attempt >= BODY_RETRIES || stopped(ctx)) break;
        log.debug(`${file.url}: download broke off after ${handled} entries (${reason(bodyError)}), starting again`);
        await sleep(1000 * (attempt + 1));
    }

    if (!scanner.recognised && !bodyError) {
        if (!probe) {
            const what = { html: 'an HTML page, not a sitemap', empty: 'an empty file', text: 'not a sitemap (no URLs in it)', unknown: 'not a sitemap (no entries in it)' }[scanner.kind];
            noteFailure(ctx, file.url, `the address returned ${what ?? 'something that is not a sitemap'}`);
        }
        return false;
    }
    if (bodyError) {
        noteFailure(ctx, file.url, `${handled > 0 ? `the download broke off after ${handled} entries, which were kept` : 'could not be read'}: ${reason(bodyError)}`);
        return handled > 0;
    }
    entry.sitemapFilesRead++;
    stats.sitemapFiles++;
    entry.entriesInvalid += scanner.invalid;
    if (info.truncated) ctx.notes.add(`a sitemap larger than ${MAX_FILE_BYTES / 1024 / 1024} MB was cut off`);
    return true;
}

/** Reads the queued sitemap files of one site, FILE_CONCURRENCY at a time; indexes add to the queue as they are read. */
function drain(ctx) {
    return new Promise((resolve) => {
        let active = 0;
        const pump = () => {
            while (active < FILE_CONCURRENCY && ctx.queue.length > 0 && !stopped(ctx)) {
                active++;
                readSitemap(ctx, ctx.queue.shift())
                    .catch((err) => log.exception(err, 'Unexpected error while reading a sitemap'))
                    .finally(async () => {
                        if (ctx.queue.length > 0) await sleep(FILE_DELAY_MS);
                        active--;
                        pump();
                    });
            }
            if (active === 0) resolve();
        };
        pump();
    });
}

async function robotsSitemaps(ctx) {
    const { origin } = ctx.target;
    const handle = await open(`${origin}/robots.txt`, 1);
    let text = '';
    try {
        for await (const part of textChunks(handle.res, {})) {
            text += part;
            if (text.length > MAX_ROBOTS_CHARS) break;
        }
    } finally {
        handle.done();
    }
    return parseRobots(text, origin);
}

async function scrapeSite(target) {
    const entry = {
        input: target.source,
        status: 'ok',
        discovery: null, // robots | guess | direct
        sitemapsFound: 0,
        sitemapFilesRead: 0,
        sitemapFilesFailed: 0,
        sitemapFilesSkippedOld: 0,
        sitemapFilesSkipped: 0,
        urlsFound: 0,
        urlsSaved: 0,
        urlsFilteredOut: 0,
        duplicates: 0,
        entriesInvalid: 0,
        failedFiles: [],
    };
    report.push(entry);
    const ctx = { target, entry, queue: [], seenFiles: new Set(), seenUrls: new Set(), accepted: 0, full: false, blocked: false, refusals: 0, refusalStreak: 0, probeErrors: [], notes: new Set() };

    if (target.kind === 'sitemap') {
        entry.discovery = 'direct';
        entry.sitemapsFound = 1;
        enqueue(ctx, { url: target.url, date: null }, 0);
        await drain(ctx);
    } else {
        let listed = [];
        let unreachable = null;
        try {
            listed = await robotsSitemaps(ctx);
            noteStatus(ctx, 200);
        } catch (err) {
            noteStatus(ctx, err.status);
            if (!err.status) unreachable = err; // no answer at all; an HTTP error still means the site is there
        }
        if (unreachable) {
            entry.status = 'unreachable';
            entry.message = `The site could not be reached: ${reason(unreachable)}.`;
        } else {
            if (listed.length > 0) {
                entry.discovery = 'robots';
                entry.sitemapsFound = listed.length;
                for (const url of listed) enqueue(ctx, { url, date: null }, 0);
                await drain(ctx);
            }
            if (entry.sitemapFilesRead === 0 && entry.urlsFound === 0 && !stopped(ctx)) {
                for (const path of GUESS_PATHS) {
                    const url = `${target.origin}${path}`;
                    if (ctx.seenFiles.has(url)) continue; // robots.txt named it and it already failed
                    ctx.seenFiles.add(url);
                    if (await readSitemap(ctx, { url, depth: 0 }, true)) {
                        entry.discovery = 'guess';
                        entry.sitemapsFound = 1;
                        await drain(ctx);
                        break;
                    }
                    if (stopped(ctx)) break;
                }
            }
        }
    }

    // The outcome in words.
    if (entry.status === 'ok') {
        const notes = [...ctx.notes];
        if (entry.sitemapFilesRead === 0 && entry.urlsSaved === 0) {
            if (ctx.blocked || (ctx.refusals > 0 && (entry.sitemapFilesFailed > 0 || ctx.probeErrors.length > 0))) {
                entry.status = 'blocked';
                entry.message = 'The site refuses automated access to its sitemaps (HTTP 401/403/429). A proxy in the input may help.';
            } else if (entry.sitemapFilesFailed > 0) {
                entry.status = 'error';
                entry.message = `${entry.discovery === 'direct' ? 'The sitemap' : 'The sitemaps named in robots.txt'} could not be read: ${entry.failedFiles[0].reason}.`;
            } else if (ctx.probeErrors.length > 0) {
                entry.status = 'error';
                entry.message = `No sitemap could be read: ${ctx.probeErrors[0]}.`;
            } else {
                entry.status = 'no_sitemap';
                entry.message = `No sitemap found: robots.txt names none and none of ${GUESS_PATHS.join(', ')} is a sitemap.`;
            }
        } else {
            if (ctx.blocked) notes.push('the site started refusing requests (HTTP 401/403/429), so the rest was not read');
            if (entry.sitemapFilesFailed > 0) notes.push(`${entry.sitemapFilesFailed} sitemap files could not be read`);
            if (ctx.blocked || entry.sitemapFilesFailed > 0 || entry.sitemapFilesSkipped > 0) entry.status = 'partial';
            if (ctx.full) notes.push(`stopped at maxUrlsPerSite (${input.maxUrlsPerSite}); the site has more`);
            if (entry.urlsSaved === 0 && !limitReached) {
                if (entry.urlsFound === 0) notes.push(entry.sitemapFilesSkippedOld > 0 ? 'every child sitemap is older than modifiedAfter' : 'the sitemaps list no URLs');
                else notes.push('every URL was filtered out or a duplicate');
            }
            if (notes.length > 0) entry.message = `${notes.join('; ')}.`.replace(/^./, (c) => c.toUpperCase());
        }
    }
    if (entry.failedFiles.length === 0) delete entry.failedFiles;

    const read = entry.status === 'ok' || entry.status === 'partial';
    if (read) stats.sitesOk++;
    else stats.sitesFailed++;
    const line = `${target.source}: ${entry.status}, ${entry.urlsSaved} URLs saved from ${entry.sitemapFilesRead} sitemap files (${entry.discovery ?? 'none found'})${entry.message ? `. ${entry.message}` : ''}`;
    if (read) log.info(line);
    else log.warning(line);
    await Actor.setStatusMessage(`${stats.sitesOk + stats.sitesFailed}/${stats.sites} sites done, ${stats.urls} URLs`);
}

// A fixed number of sites at a time.
let next = 0;
await Promise.all(Array.from({ length: Math.min(SITE_CONCURRENCY, input.targets.length) }, async () => {
    while (next < input.targets.length && !limitReached) await scrapeSite(input.targets[next++]);
}));
await pushing;

const peakMemoryMb = Math.round(process.resourceUsage().maxRSS / 1024);
await Actor.setValue('SUMMARY', {
    ...stats,
    limitReached,
    modifiedAfter: input.modifiedAfterIso,
    peakMemoryMb,
    siteReport: report,
});
log.info(`Peak memory: ${peakMemoryMb} MB, ${stats.requests} requests.`);

if (limitReached) log.info('The spending limit for this run was reached; stopped early with the results saved so far.');
if (report.length > 0 && report.every((r) => r.status === 'unreachable' || r.status === 'blocked' || r.status === 'error')) {
    await Actor.fail('None of the sites could be read: every request failed. Nothing was charged for results. Details are in the SUMMARY record; try again, or set a proxy in the input.');
}
const notes = [
    stats.sitesFailed ? `${stats.sitesFailed} sites without results` : null,
    limitReached ? 'spending limit reached' : null,
].filter(Boolean);
await Actor.exit(`Done: ${stats.urls} URLs from ${stats.sitemapFiles} sitemap files of ${stats.sitesOk} of ${stats.sites} sites${notes.length ? ` (${notes.join(', ')})` : ''}. Per-site details are in the SUMMARY record.`);
