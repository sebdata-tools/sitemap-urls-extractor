// Pure functions: input checks, robots.txt and sitemap parsing (XML, text, RSS/Atom), dates and URL filters.
// No network and no Apify SDK here, so everything in this file is unit-tested on saved fixtures.

export const MAX_SITES = 500;
export const DEFAULT_MAX_URLS = 10_000;
export const MAX_URLS_LIMIT = 50_000_000;
/** Tried in this order when robots.txt names no sitemap; the first one that parses wins. */
export const GUESS_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.txt', '/wp-sitemap.xml'];

export class InputError extends Error {}

// ---------------------------------------------------------------- input

/**
 * Turns one "sites" entry into a target.
 * A URL whose path ends in .xml, .xml.gz, .txt (or .txt.gz) or contains "sitemap" is read as a sitemap file
 * ({ kind: 'sitemap', url }); anything else is a website whose sitemaps are discovered ({ kind: 'site', origin }).
 */
export function parseSite(entry) {
    const raw = String(entry).trim();
    if (!raw) return null;
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
        throw new InputError(`"${raw}" is not a valid website or sitemap URL.`);
    }
    if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(url.hostname) || /^[\d.]+$/.test(url.hostname)) {
        throw new InputError(`"${raw}" is not a valid website or sitemap URL.`);
    }
    const path = url.pathname.toLowerCase();
    const direct = !/\/robots\.txt$/.test(path)
        && (/\.(xml|txt)(\.gz)?$/.test(path) || (path + url.search.toLowerCase()).includes('sitemap'));
    url.hash = '';
    return {
        kind: direct ? 'sitemap' : 'site',
        origin: url.origin,
        host: url.hostname.toLowerCase(),
        url: direct ? url.href : null,
        source: raw,
    };
}

const cleanCount = (value, field, max, fallback) => {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new InputError(`"${field}" must be a whole number from 0 to ${max} (0 = no limit).`);
    return n;
};

/**
 * URL filters. Each pattern is used as a regular expression when it is a valid one, and always also as plain
 * text, so both "\\.html$" and "/product?id=" do what they look like. Case-sensitive, like URLs.
 */
export function compilePatterns(list, field) {
    if (list == null || list === '') return [];
    const items = typeof list === 'string' ? list.split(/\r?\n/) : list;
    if (!Array.isArray(items)) throw new InputError(`"${field}" must be a list of text patterns.`);
    const out = [];
    for (const item of items) {
        if (typeof item !== 'string') throw new InputError(`Every entry of "${field}" must be a text string.`);
        const text = item.trim();
        if (!text) continue;
        if (text.length > 500) throw new InputError(`A pattern in "${field}" is longer than 500 characters.`);
        let regex = null;
        try {
            regex = new RegExp(text);
        } catch {
            regex = null; // not a regular expression: plain text only
        }
        out.push({ text, regex });
    }
    return out;
}

export const matchesAny = (url, patterns) => patterns.some((p) => url.includes(p.text) || (p.regex !== null && p.regex.test(url)));

/** include/exclude decision for one URL. */
export function passesPatterns(url, include, exclude) {
    if (include.length > 0 && !matchesAny(url, include)) return false;
    return !(exclude.length > 0 && matchesAny(url, exclude));
}

const UNIT_MS = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };

/** "modifiedAfter": a date, a date-time, or a relative age ("7 days", "2 weeks"). Returns a UTC timestamp or null. */
export function parseModifiedAfter(value, now = Date.now()) {
    if (value == null || String(value).trim() === '') return null;
    const raw = String(value).trim();
    const rel = /^(\d+)\s*(hour|day|week|month|year)s?(\s+ago)?$/i.exec(raw);
    if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
    const date = normalizeLastmod(raw);
    if (!date) throw new InputError(`"modifiedAfter" must be a date such as 2026-01-31, a date and time such as 2026-01-31T12:00:00Z, or an age such as "7 days" (got "${raw}").`);
    return date.from;
}

/** Validates the raw Actor input and fills defaults. Throws InputError with a message a user can act on. */
export function normalizeInput(raw, now = Date.now()) {
    const input = raw ?? {};
    let { sites } = input;
    if (typeof sites === 'string') sites = sites.split(/\r?\n/);
    if (!Array.isArray(sites)) {
        throw new InputError('Input field "sites" is required: a list of websites or sitemap URLs, e.g. ["https://www.example.com", "example.org/sitemap_index.xml"].');
    }
    const targets = [];
    const seen = new Set();
    for (const entry of sites) {
        const value = entry && typeof entry === 'object' ? entry.url : entry; // also accepts [{ url }] (Apify request list)
        if (typeof value !== 'string') throw new InputError('Every entry of "sites" must be a text string.');
        const target = parseSite(value);
        if (!target) continue;
        const key = target.kind === 'site' ? target.origin : target.url;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(target);
    }
    if (targets.length === 0) throw new InputError('Input field "sites" is empty: give at least one website or sitemap URL.');
    if (targets.length > MAX_SITES) throw new InputError(`Too many sites: ${targets.length}. The limit is ${MAX_SITES} per run.`);

    const modifiedAfter = parseModifiedAfter(input.modifiedAfter, now);
    return {
        targets,
        maxUrlsPerSite: cleanCount(input.maxUrlsPerSite, 'maxUrlsPerSite', MAX_URLS_LIMIT, DEFAULT_MAX_URLS),
        include: compilePatterns(input.includePatterns, 'includePatterns'),
        exclude: compilePatterns(input.excludePatterns, 'excludePatterns'),
        modifiedAfter,
        modifiedAfterIso: modifiedAfter === null ? null : new Date(modifiedAfter).toISOString(),
        includeExtensions: input.includeExtensions === true,
        proxyConfiguration: input.proxyConfiguration ?? null,
    };
}

// ---------------------------------------------------------------- dates

const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * A sitemap date as { value, from, to }, or null when unreadable.
 * `value`: a date without a time stays as given (2026-01-31; also 2026-01 and 2026); a date with a time becomes
 * ISO 8601 UTC (2026-01-31T10:00:00.000Z; no time zone given = UTC). `from`/`to` are the first and last
 * millisecond the value covers, so a date without a time covers its whole day.
 */
export function normalizeLastmod(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;

    let m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
    if (m) {
        const y = Number(m[1]);
        const mo = m[2] ? Number(m[2]) : null;
        const d = m[3] ? Number(m[3]) : null;
        if (y < 1990 || y > 2100 || (mo !== null && (mo < 1 || mo > 12)) || (d !== null && (d < 1 || d > lastDay(y, mo)))) return null;
        const from = Date.UTC(y, (mo ?? 1) - 1, d ?? 1);
        let to = from + 86_399_999;
        if (d === null) to = (mo === null ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, mo, 1)) - 1; // a whole month or year
        return { value: s, from, to };
    }

    m = /^(\d{4}-\d{2}-\d{2})[Tt\s]+(\d{2}:\d{2})(:\d{2})?([.,]\d+)?\s*([Zz]|[+-]\d{2}(?::?\d{2})?)?$/.exec(s);
    let ts = NaN;
    if (m) {
        let tz = (m[5] ?? 'Z').toUpperCase();
        if (tz !== 'Z') tz = `${tz.slice(0, 3)}:${tz.length > 3 ? tz.slice(-2) : '00'}`;
        const frac = m[4] ? `.${m[4].slice(1, 4).padEnd(3, '0')}` : '';
        ts = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ':00'}${frac}${tz}`);
    } else if (/^(?:[A-Za-z]{3},?\s+)?\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/.test(s)) {
        ts = Date.parse(s); // RSS dates: "Fri, 13 Nov 2026 08:00:00 GMT"
    }
    if (Number.isNaN(ts) || ts < Date.UTC(1990, 0, 1) || ts > Date.UTC(2101, 0, 1)) return null;
    return { value: new Date(ts).toISOString(), from: ts, to: ts };
}

/** True when a (normalised) lastmod is on or after the cut-off. No lastmod = false. */
export const isOnOrAfter = (date, cutoff) => date !== null && date.to >= cutoff;

// ---------------------------------------------------------------- robots.txt

/** The sitemap URLs named by "Sitemap:" lines of a robots.txt, in order, without repeats. Relative ones are resolved. */
export function parseRobots(text, origin) {
    const out = [];
    const seen = new Set();
    for (const line of String(text ?? '').replace(/^﻿/, '').split(/\r?\n|\r/)) {
        const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
        if (!m) continue;
        const url = cleanUrl(m[1], `${origin}/`);
        if (url && !seen.has(url)) {
            seen.add(url);
            out.push(url);
        }
    }
    return out;
}

// ---------------------------------------------------------------- text helpers

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text of an XML node: CDATA unwrapped, the XML entities decoded (once), surrounding space removed. */
export function xmlText(raw) {
    if (raw == null) return '';
    return String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, cdata, ent) => {
        if (cdata !== undefined) return cdata;
        if (ent[0] === '#') {
            const n = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
        }
        return NAMED[ent.toLowerCase()];
    }).trim();
}

/** An absolute http(s) URL as given (trimmed), a relative one resolved against `base`, or null. */
export function cleanUrl(raw, base) {
    const s = String(raw ?? '').trim();
    if (!s || /\s/.test(s)) return null;
    if (/^https?:\/\//i.test(s)) return URL.canParse(s) ? s : null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // mailto:, javascript:, ...
    if (!base) return null;
    try {
        return new URL(s, base).href;
    } catch {
        return null;
    }
}

/** 53-bit hash of a string (cyrb53): lets a site's URLs be de-duplicated without keeping every URL in memory. */
export function hashUrl(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ---------------------------------------------------------------- XML blocks

const PREFIX = '(?:[\\w.-]+:)?';
const valueRes = new Map();
/** Text of the first <name> (any namespace prefix) inside a block, or null. */
function tagValue(block, name) {
    let re = valueRes.get(name);
    if (!re) {
        re = new RegExp(`<${PREFIX}${name}(?=[\\s>])[^>]*>([\\s\\S]*?)</${PREFIX}${name}\\s*>`, 'i');
        valueRes.set(name, re);
    }
    const m = re.exec(block);
    if (!m) return null;
    const text = xmlText(m[1]);
    return text === '' ? null : text;
}

const EXT_BLOCK = /<([\w.-]+:)?(image|video|news)(?=[\s>])[^>]*>[\s\S]*?<\/\1\2\s*>/gi;
const LINK_TAG = /<(?:[\w.-]+:)?link(?=[\s/])([^>]*)>/gi;
const attr = (attrs, name) => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    return m ? xmlText(m[1] ?? m[2]) : null;
};
const num = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
};
const dateValue = (v) => normalizeLastmod(v)?.value ?? null;
/** The object without its empty fields. */
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null));

/** The image, video, news and hreflang data of one <url> block; only the lists that have entries. */
export function parseExtensions(block, base) {
    const out = {};
    const images = [];
    const videos = [];
    const news = [];
    for (const m of block.matchAll(EXT_BLOCK)) {
        const part = m[0];
        const kind = m[2].toLowerCase();
        if (kind === 'image') {
            const url = cleanUrl(tagValue(part, 'loc'), base);
            if (url) images.push(compact({ url, title: tagValue(part, 'title'), caption: tagValue(part, 'caption') }));
        } else if (kind === 'video') {
            videos.push(compact({
                title: tagValue(part, 'title'),
                description: tagValue(part, 'description'),
                thumbnailUrl: cleanUrl(tagValue(part, 'thumbnail_loc'), base),
                contentUrl: cleanUrl(tagValue(part, 'content_loc'), base),
                playerUrl: cleanUrl(tagValue(part, 'player_loc'), base),
                durationSeconds: num(tagValue(part, 'duration')),
                publicationDate: dateValue(tagValue(part, 'publication_date')),
            }));
        } else {
            news.push(compact({
                title: tagValue(part, 'title'),
                publicationName: tagValue(part, 'name'),
                language: tagValue(part, 'language'),
                publicationDate: dateValue(tagValue(part, 'publication_date')),
            }));
        }
    }
    const alternates = [];
    for (const m of block.matchAll(LINK_TAG)) {
        const href = cleanUrl(attr(m[1], 'href'), base);
        const hreflang = attr(m[1], 'hreflang');
        if (href && hreflang) alternates.push({ hreflang, href });
    }
    if (images.length) out.images = images;
    if (videos.length) out.videos = videos;
    if (news.length) out.news = news;
    if (alternates.length) out.alternates = alternates;
    return out;
}

/** One <url> block as a record, or null when it has no usable <loc>. */
function urlRecord(block, base, extensions) {
    const main = block.replace(EXT_BLOCK, '');
    const url = cleanUrl(tagValue(main, 'loc'), base);
    if (!url) return null;
    const date = normalizeLastmod(tagValue(main, 'lastmod'));
    const changefreq = tagValue(main, 'changefreq');
    const rec = {
        type: 'url',
        url,
        lastmod: date?.value ?? null,
        date,
        changefreq: changefreq ? changefreq.toLowerCase() : null,
        priority: num(tagValue(main, 'priority')),
    };
    if (extensions) Object.assign(rec, parseExtensions(block, base));
    return rec;
}

/** One <sitemap> block of an index. */
function sitemapRecord(block, base) {
    const url = cleanUrl(tagValue(block, 'loc'), base);
    if (!url) return null;
    const date = normalizeLastmod(tagValue(block, 'lastmod'));
    return { type: 'sitemap', url, lastmod: date?.value ?? null, date };
}

/** One RSS <item> or Atom <entry>: the link and its date. */
function feedRecord(block, base) {
    let link = null;
    for (const m of block.matchAll(LINK_TAG)) { // Atom: <link href="..." rel="alternate"/>
        const href = cleanUrl(attr(m[1], 'href'), base);
        const rel = attr(m[1], 'rel');
        if (href && (!rel || rel === 'alternate')) {
            link = href;
            break;
        }
    }
    link ??= cleanUrl(tagValue(block, 'link'), base) ?? cleanUrl(tagValue(block, 'guid'), null);
    if (!link) return null;
    const date = normalizeLastmod(tagValue(block, 'pubDate') ?? tagValue(block, 'updated') ?? tagValue(block, 'date') ?? tagValue(block, 'published'));
    return { type: 'url', url: link, lastmod: date?.value ?? null, date, changefreq: null, priority: null };
}

// ---------------------------------------------------------------- the scanner

const ROOTS = { urlset: 'urlset', sitemapindex: 'index', rss: 'rss', rdf: 'rss', feed: 'atom', html: 'html', head: 'html', body: 'html' };
const BLOCK_NAMES = { urlset: 'url|sitemap', index: 'url|sitemap', unknown: 'url|sitemap', rss: 'item', atom: 'entry' };
const HEAD_CHARS = 1024; // how much text is needed before the kind of file is decided
const MAX_BLOCK_CHARS = 2_000_000; // an "entry" larger than this is junk and is dropped
const LOOSE_LOC = /<(?:[\w.-]+:)?loc(?=[\s>])[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?loc\s*>/gi;

/**
 * Reads a sitemap of any kind piece by piece: push(text) and end() return the records found so far,
 * { type: 'url', url, lastmod, date, changefreq, priority, [images, videos, news, alternates] } or
 * { type: 'sitemap', url, lastmod, date }. Only the unfinished entry is kept in memory, so a file of any size
 * can be streamed through it.
 *
 * It does not parse XML strictly: it looks for <url>, <sitemap>, <item> and <entry> blocks (any namespace
 * prefix), so a file with a missing closing tag, junk before the XML declaration, a cut-off end or no wrapper
 * elements at all (bare <loc> tags) still gives its URLs.
 */
export class SitemapScanner {
    /** @param {string} baseUrl the sitemap's own URL (relative locations are resolved against it) */
    constructor(baseUrl, { extensions = false } = {}) {
        this.base = baseUrl;
        this.extensions = extensions;
        /** null until decided, then: urlset | index | rss | atom | text | html | unknown | empty */
        this.kind = null;
        this.buf = '';
        this.inBlock = false; // buf starts with the opening tag of an unfinished block
        this.blocks = 0;
        this.records = 0;
        this.invalid = 0; // entries without a usable URL, and non-URL lines of a text sitemap
        this.re = null;
    }

    /** True when the file turned out to be a sitemap or feed (decided after the first ~1,000 characters). */
    get recognised() {
        if (this.kind === 'urlset' || this.kind === 'index' || this.kind === 'rss' || this.kind === 'atom') return true;
        return (this.kind === 'unknown' || this.kind === 'text') && this.records > 0;
    }

    push(text) {
        this.buf += text;
        if (this.kind === null) {
            if (this.buf.length < HEAD_CHARS) return [];
            this.#detect();
        }
        return this.#scan(false);
    }

    end() {
        if (this.kind === null) this.#detect();
        return this.#scan(true);
    }

    #detect() {
        this.buf = this.buf.replace(/^[﻿\s]+/, '');
        const head = this.buf.slice(0, 8192).replace(/<!--[\s\S]*?-->/g, '');
        if (head === '') {
            this.kind = 'empty';
        } else {
            // The first element decides. Junk before the XML (a PHP warning, say) is tolerated: when the first
            // element is not a known root, a <urlset> or <sitemapindex> further down the head still counts.
            const first = head[0] === '<' ? /<(?![?!/])(?:[\w.-]+:)?([A-Za-z_][\w.-]*)/.exec(head) : null;
            const later = /<(?:[\w.-]+:)?(urlset|sitemapindex)(?=[\s>])/i.exec(head);
            this.kind = ROOTS[first?.[1].toLowerCase()] ?? ROOTS[later?.[1].toLowerCase()] ?? (head[0] === '<' ? 'unknown' : 'text');
        }
        const names = BLOCK_NAMES[this.kind];
        if (names) this.re = new RegExp(`<(/?)${PREFIX}(?:${names})(?=[\\s>/])[^>]*>`, 'gi');
    }

    #emit(out, rec) {
        if (rec) {
            this.records++;
            out.push(rec);
        } else {
            this.invalid++;
        }
    }

    #block(out, block) {
        this.blocks++;
        const name = /^<(?:[\w.-]+:)?([\w.-]+)/.exec(block)[1].toLowerCase();
        if (name === 'sitemap') this.#emit(out, sitemapRecord(block, this.base));
        else if (name === 'url') this.#emit(out, urlRecord(block, this.base, this.extensions));
        else this.#emit(out, feedRecord(block, this.base));
    }

    /** Text outside any block: in a file without wrapper elements the bare <loc> values are the entries. */
    #loose(out, text) {
        if (this.blocks > 0 || this.kind === 'rss' || this.kind === 'atom' || !text.includes('loc')) return;
        for (const m of text.matchAll(LOOSE_LOC)) {
            const url = cleanUrl(xmlText(m[1]), this.base);
            if (!url) this.invalid++;
            else if (this.kind === 'index') this.#emit(out, { type: 'sitemap', url, lastmod: null, date: null });
            else this.#emit(out, { type: 'url', url, lastmod: null, date: null, changefreq: null, priority: null });
        }
    }

    #scan(final) {
        const out = [];
        if (this.kind === 'html' || this.kind === 'empty') {
            this.buf = '';
            return out;
        }
        if (this.kind === 'text') {
            const lines = this.buf.split(/\r?\n|\r/);
            this.buf = final ? '' : lines.pop();
            if (this.buf.length > MAX_BLOCK_CHARS) this.buf = '';
            for (const line of lines) {
                const s = line.trim();
                if (!s || s[0] === '#') continue;
                this.#emit(out, /^https?:\/\/\S+$/i.test(s) && URL.canParse(s)
                    ? { type: 'url', url: s, lastmod: null, date: null, changefreq: null, priority: null } : null);
            }
            return out;
        }

        const { buf, re } = this;
        let start = this.inBlock ? 0 : -1; // where the current block's opening tag is
        let consumed = 0; // everything before this is dealt with
        re.lastIndex = this.inBlock ? 1 : 0;
        for (let m = re.exec(buf); m !== null; m = re.exec(buf)) {
            if (m[1] === '/') {
                if (start >= 0) this.#block(out, buf.slice(start, m.index));
                else this.#loose(out, buf.slice(consumed, m.index));
                start = -1;
                consumed = re.lastIndex;
            } else if (!m[0].endsWith('/>')) {
                // An opening tag while a block is still open: its closing tag is missing, so it ends here.
                if (start >= 0) this.#block(out, buf.slice(start, m.index));
                else this.#loose(out, buf.slice(consumed, m.index));
                start = m.index;
                consumed = m.index;
            }
        }

        if (start >= 0) {
            if (final) {
                this.#block(out, buf.slice(start)); // the file ends inside an entry: keep it if its <loc> is whole
                this.buf = '';
                this.inBlock = false;
            } else if (buf.length - start > MAX_BLOCK_CHARS) {
                this.buf = '';
                this.inBlock = false;
            } else {
                this.buf = buf.slice(start);
                this.inBlock = true;
            }
            return out;
        }

        let rest = buf.slice(consumed);
        let keep = '';
        if (!final) {
            // Keep what may be cut in half by the chunk boundary: an unfinished tag, or an unfinished bare <loc>.
            let cut = rest.lastIndexOf('<');
            if (cut >= 0 && rest.indexOf('>', cut) >= 0) cut = -1;
            if (this.blocks === 0) {
                let locOpen = -1;
                for (const m of rest.matchAll(/<(?:[\w.-]+:)?loc(?=[\s>])/gi)) locOpen = m.index;
                if (locOpen >= 0 && !/<\/(?:[\w.-]+:)?loc\s*>/i.test(rest.slice(locOpen)) && (cut < 0 || locOpen < cut)) cut = locOpen;
            }
            if (cut >= 0 && rest.length - cut <= 8192) {
                keep = rest.slice(cut);
                rest = rest.slice(0, cut);
            }
        }
        this.#loose(out, rest);
        this.buf = keep;
        this.inBlock = false;
        return out;
    }
}

/** A whole sitemap held in memory (tests, small files): { kind, recognised, urls, sitemaps, invalid }. */
export function parseSitemap(text, baseUrl, options) {
    const scanner = new SitemapScanner(baseUrl, options);
    const records = [...scanner.push(String(text)), ...scanner.end()];
    return {
        kind: scanner.kind,
        recognised: scanner.recognised,
        urls: records.filter((r) => r.type === 'url'),
        sitemaps: records.filter((r) => r.type === 'sitemap'),
        invalid: scanner.invalid,
    };
}

// ---------------------------------------------------------------- output

/** The dataset row for one URL record. */
export function toRow(rec, sitemapUrl, site) {
    const row = { url: rec.url, lastmod: rec.lastmod, changefreq: rec.changefreq, priority: rec.priority, sitemapUrl, site };
    if (rec.images) row.images = rec.images;
    if (rec.videos) row.videos = rec.videos;
    if (rec.news) row.news = rec.news;
    if (rec.alternates) row.alternates = rec.alternates;
    return row;
}
