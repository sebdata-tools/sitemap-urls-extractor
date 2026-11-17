// Unit tests on saved files in test/fixtures/ (captured 2026-11-14). No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import zlib from 'node:zlib';

import {
    DEFAULT_MAX_URLS, GUESS_PATHS, InputError, SitemapScanner, cleanUrl, compilePatterns, hashUrl, isOnOrAfter, matchesAny, normalizeInput,
    normalizeLastmod, parseExtensions, parseModifiedAfter, parseRobots, parseSite, parseSitemap, passesPatterns, toRow, xmlText,
} from '../src/lib.js';

const bytes = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const fixture = (name) => bytes(name).toString('utf8');
const occurrences = (text, needle) => text.split(needle).length - 1;
const BASE = 'https://example.test/sitemap.xml';
const plain = (rec) => {
    const { type, date, ...rest } = rec;
    return rest;
};
/** The same file fed to the scanner in pieces of `size` characters. */
function inPieces(text, size, options) {
    const scanner = new SitemapScanner(BASE, options);
    const records = [];
    for (let i = 0; i < text.length; i += size) records.push(...scanner.push(text.slice(i, i + size)));
    records.push(...scanner.end());
    return { scanner, records };
}

test('parseSite: websites and direct sitemap URLs', () => {
    assert.deepEqual(parseSite(' Yoast.com '), { kind: 'site', origin: 'https://yoast.com', host: 'yoast.com', url: null, source: 'Yoast.com' });
    assert.equal(parseSite('http://example.com/blog/?a=1').origin, 'http://example.com');
    assert.equal(parseSite('https://example.com/blog/').kind, 'site');
    assert.equal(parseSite('https://example.com/robots.txt').kind, 'site');
    for (const direct of ['https://yoast.com/sitemap_index.xml', 'www.mkdocs.org/sitemap.xml.gz', 'https://www.xml-sitemaps.com/urllist.txt',
        'https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml', 'https://example.com/feed.xml', 'https://example.com/?sitemap=1', 'https://example.com/Sitemap']) {
        assert.equal(parseSite(direct).kind, 'sitemap', direct);
    }
    assert.equal(parseSite('www.mkdocs.org/sitemap.xml.gz').url, 'https://www.mkdocs.org/sitemap.xml.gz');
    assert.equal(parseSite('https://www.allbirds.com/sitemap_products_1.xml?from=1&to=2#x').url, 'https://www.allbirds.com/sitemap_products_1.xml?from=1&to=2');
    assert.equal(parseSite('sitemaps.org').kind, 'site'); // "sitemap" in the host name does not make it a sitemap file
    assert.equal(parseSite(''), null);
    for (const bad of ['not a url', 'localhost', '127.0.0.1', 'ftp://example.com']) assert.throws(() => parseSite(bad), InputError, bad);
});

test('normalizeInput: defaults, duplicates removed, bad input rejected', () => {
    const input = normalizeInput({ sites: ['yoast.com', 'https://yoast.com/', 'yoast.com/sitemap_index.xml', '', { url: 'https://kubernetes.io' }] });
    assert.deepEqual(input.targets.map((t) => `${t.kind}|${t.host}`), ['site|yoast.com', 'sitemap|yoast.com', 'site|kubernetes.io']);
    assert.equal(input.maxUrlsPerSite, DEFAULT_MAX_URLS);
    assert.equal(DEFAULT_MAX_URLS, 10_000);
    assert.equal(input.modifiedAfter, null);
    assert.equal(input.includeExtensions, false);
    assert.deepEqual([input.include, input.exclude], [[], []]);
    const full = normalizeInput({ sites: 'a.com\nb.com', maxUrlsPerSite: 0, includePatterns: ['/blog/', ' '], excludePatterns: '\\.pdf$\n/tag/', modifiedAfter: '2026-01-31', includeExtensions: true });
    assert.equal(full.targets.length, 2);
    assert.equal(full.maxUrlsPerSite, 0);
    assert.equal(full.include.length, 1);
    assert.equal(full.exclude.length, 2);
    assert.equal(full.modifiedAfterIso, '2026-01-31T00:00:00.000Z');
    assert.equal(full.includeExtensions, true);
    for (const bad of [null, {}, { sites: [] }, { sites: [3] }, { sites: ['a.com'], maxUrlsPerSite: 1.5 }, { sites: ['a.com'], maxUrlsPerSite: -1 },
        { sites: ['a.com'], modifiedAfter: 'yesterday' }, { sites: ['a.com'], includePatterns: [5] }, { sites: ['a.com'], excludePatterns: {} }]) {
        assert.throws(() => normalizeInput(bad), InputError, JSON.stringify(bad));
    }
});

test('patterns: regular expression or plain text', () => {
    const p = compilePatterns(['\\.html$', '/product?id=', '[unclosed', '^https://docs\\.'], 'includePatterns');
    assert.equal(p[2].regex, null); // not a valid regular expression: plain text only
    assert.equal(matchesAny('https://a.com/x.html', p), true);
    assert.equal(matchesAny('https://a.com/x.html?page=2', p), false);
    assert.equal(matchesAny('https://a.com/product?id=7', p), true); // as text, although as a regex it would not match
    assert.equal(matchesAny('https://a.com/a[unclosed', p), true);
    assert.equal(matchesAny('https://docs.a.com/', p), true);
    assert.equal(matchesAny('https://a.com/Docs.', p), false); // case-sensitive
    const blog = compilePatterns(['/blog/'], 'x');
    const tag = compilePatterns(['/tag/', '\\d{4}$'], 'x');
    assert.equal(passesPatterns('https://a.com/blog/post', blog, tag), true);
    assert.equal(passesPatterns('https://a.com/blog/tag/x', blog, tag), false);
    assert.equal(passesPatterns('https://a.com/blog/2024', blog, tag), false);
    assert.equal(passesPatterns('https://a.com/shop', blog, tag), false);
    assert.equal(passesPatterns('https://a.com/shop', [], tag), true);
    assert.equal(passesPatterns('https://a.com/shop', [], []), true);
});

test('normalizeLastmod: the date forms sitemaps use', () => {
    assert.deepEqual(normalizeLastmod('2016-11-21'), { value: '2016-11-21', from: Date.UTC(2016, 10, 21), to: Date.UTC(2016, 10, 22) - 1 });
    assert.equal(normalizeLastmod(' 2026-07-24T17:15:16+00:00 ').value, '2026-07-24T17:15:16.000Z');
    assert.equal(normalizeLastmod('2026-11-14T10:30:00+02:00').value, '2026-11-14T08:30:00.000Z');
    assert.equal(normalizeLastmod('2026-11-12T14:06:14.408462Z').value, '2026-11-12T14:06:14.408Z');
    assert.equal(normalizeLastmod('2026-11-14T08:10Z').value, '2026-11-14T08:10:00.000Z');
    assert.equal(normalizeLastmod('2026-11-14 08:10:00').value, '2026-11-14T08:10:00.000Z'); // no zone: UTC
    assert.equal(normalizeLastmod('2026-11-14T08:10:00-0500').value, '2026-11-14T13:10:00.000Z');
    assert.equal(normalizeLastmod('Fri, 13 Nov 2026 12:00:00 +0000').value, '2026-11-13T12:00:00.000Z');
    assert.deepEqual(normalizeLastmod('2026-02'), { value: '2026-02', from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 2, 1) - 1 });
    assert.equal(normalizeLastmod('2026').to, Date.UTC(2027, 0, 1) - 1);
    for (const bad of [null, '', '2016-', '0000-00-00', '2026-13-01', '2026-02-30', 'yesterday', '14/11/2026', '1']) assert.equal(normalizeLastmod(bad), null, String(bad));
});

test('modifiedAfter: dates, date-times, ages; a date without a time covers its whole day', () => {
    const now = Date.UTC(2026, 10, 14, 12);
    assert.equal(parseModifiedAfter('2026-11-01'), Date.UTC(2026, 10, 1));
    assert.equal(parseModifiedAfter('2026-11-01T06:00:00Z'), Date.UTC(2026, 10, 1, 6));
    assert.equal(parseModifiedAfter('7 days', now), now - 7 * 86_400_000);
    assert.equal(parseModifiedAfter('2 weeks ago', now), now - 14 * 86_400_000);
    assert.equal(parseModifiedAfter('', now), null);
    assert.throws(() => parseModifiedAfter('soon'), InputError);
    const cutoff = parseModifiedAfter('2026-11-01T06:00:00Z');
    assert.equal(isOnOrAfter(normalizeLastmod('2026-11-01'), cutoff), true); // that day, time unknown: kept
    assert.equal(isOnOrAfter(normalizeLastmod('2026-10-31'), cutoff), false);
    assert.equal(isOnOrAfter(normalizeLastmod('2026-11-01T05:59:59Z'), cutoff), false);
    assert.equal(isOnOrAfter(normalizeLastmod('2026-11-01T06:00:00Z'), cutoff), true);
    assert.equal(isOnOrAfter(null, cutoff), false); // no lastmod: not kept
});

test('xmlText and cleanUrl: CDATA, entities, relative URLs', () => {
    assert.equal(xmlText(' <![CDATA[ https://a.com/?x=1&y=2 ]]> '), 'https://a.com/?x=1&y=2');
    assert.equal(xmlText('https://a.com/?x=1&amp;y=2&#38;z=3&#x26;w=&quot;q&quot;'), 'https://a.com/?x=1&y=2&z=3&w="q"');
    assert.equal(xmlText('a&amp;amp;b &nbsp; &b=2'), 'a&amp;b &nbsp; &b=2'); // decoded once; unknown and bare ones left alone
    assert.equal(cleanUrl(' https://a.com/Path?x=1 ', BASE), 'https://a.com/Path?x=1'); // as given
    assert.equal(cleanUrl('/docs/page', BASE), 'https://example.test/docs/page');
    assert.equal(cleanUrl('//cdn.a.com/x.png', BASE), 'https://cdn.a.com/x.png');
    for (const bad of ['', 'mailto:a@b.c', 'javascript:void(0)', 'https://a.com/a b', 'https://']) assert.equal(cleanUrl(bad, BASE), null, bad);
});

test('hashUrl: stable and different for different URLs', () => {
    assert.equal(hashUrl('https://a.com/'), hashUrl('https://a.com/'));
    const urls = parseSitemap(zlib.gunzipSync(bytes('urlset_learnenough_named_txt.gz')).toString('utf8'), BASE).urls.map((u) => u.url);
    assert.equal(new Set(urls.map(hashUrl)).size, new Set(urls).size);
    assert.ok(urls.map(hashUrl).every((h) => Number.isSafeInteger(h) && h >= 0));
});

test('robots.txt: every Sitemap line, in order (wordpress.org)', () => {
    const text = fixture('robots_wordpress_org.txt');
    const list = parseRobots(text, 'https://wordpress.org');
    assert.equal(list.length, 9);
    assert.equal(list.length, occurrences(text, 'Sitemap: '));
    assert.equal(list[0], 'https://wordpress.org/sitemap.xml');
    assert.equal(list[8], 'https://wordpress.org/photos/sitemap.xml');
    assert.deepEqual(parseRobots('\uFEFFUser-agent: *\r\nSITEMAP : /sitemap.xml \r\nsitemap:https://a.com/s2.xml # x\nSitemap: /sitemap.xml\nSitemap:\n# Sitemap: https://a.com/no.xml', 'https://a.com'),
        ['https://a.com/sitemap.xml', 'https://a.com/s2.xml']);
    assert.deepEqual(parseRobots(fixture('not_sitemap_caniuse_trimmed.html'), 'https://caniuse.com'), []);
    assert.deepEqual(parseRobots('', 'https://a.com'), []);
});

test('sitemap index (Yoast): child sitemaps with lastmod', () => {
    const text = fixture('index_yoast.xml');
    const r = parseSitemap(text, 'https://yoast.com/sitemap_index.xml');
    assert.equal(r.kind, 'index');
    assert.equal(r.recognised, true);
    assert.equal(r.urls.length, 0);
    assert.equal(r.sitemaps.length, 21);
    assert.equal(r.sitemaps.length, occurrences(text, '<sitemap>'));
    assert.deepEqual(plain(r.sitemaps[0]), { url: 'https://yoast.com/post-sitemap.xml', lastmod: '2026-10-30T14:46:16.000Z' });
    assert.ok(r.sitemaps.every((s) => s.url.startsWith('https://yoast.com/') && s.url.endsWith('.xml') && s.date));
});

test('sitemap index (Shopify): entity-encoded URLs, a comment, no lastmod', () => {
    const r = parseSitemap(fixture('index_allbirds_shopify.xml'), 'https://www.allbirds.com/sitemap.xml');
    assert.equal(r.kind, 'index');
    assert.equal(r.sitemaps.length, 8);
    assert.deepEqual(plain(r.sitemaps[1]), { url: 'https://www.allbirds.com/sitemap_products_1.xml?from=1878193471557&to=7369944137808', lastmod: null });
    assert.ok(r.sitemaps.every((s) => !s.url.includes('&amp;')));
});

test('urlset with lastmod and priority (postgresql.org, one long line)', () => {
    const text = fixture('urlset_postgresql_trimmed.xml');
    const r = parseSitemap(text, 'https://www.postgresql.org/sitemap.xml');
    assert.equal(r.kind, 'urlset');
    assert.equal(r.urls.length, 36);
    assert.equal(r.urls.length, occurrences(text, '<url>'));
    assert.deepEqual(plain(r.urls[0]), { url: 'https://www.postgresql.org/', lastmod: null, changefreq: null, priority: null });
    assert.deepEqual(plain(r.urls[6]), { url: 'https://www.postgresql.org/docs/19/encryption-options.html', lastmod: '2026-11-12T14:06:14.408Z', changefreq: null, priority: 0.1 });
    assert.equal(r.urls.filter((u) => typeof u.priority === 'number').length, occurrences(text, '<priority>'));
    assert.equal(r.urls.filter((u) => u.lastmod).length, occurrences(text, '<lastmod>'));
    assert.equal(r.invalid, 0);
});

test('image extension (Yoast page sitemap): off by default, on with the option', () => {
    const text = fixture('urlset_yoast_page_images_trimmed.xml');
    const off = parseSitemap(text, BASE);
    assert.equal(off.urls.length, 25);
    assert.ok(off.urls.every((u) => !('images' in u)));
    assert.deepEqual(plain(off.urls[0]), { url: 'https://yoast.com/', lastmod: '2026-07-24T17:15:16.000Z', changefreq: null, priority: null });
    const on = parseSitemap(text, BASE, { extensions: true });
    assert.deepEqual(on.urls.map((u) => u.url), off.urls.map((u) => u.url)); // an image's <loc> is never taken for the page's
    assert.equal(on.urls.reduce((n, u) => n + (u.images?.length ?? 0), 0), occurrences(text, '<image:image>'));
    assert.deepEqual(on.urls[0].images[0], { url: 'https://yoast.com/app/uploads/2025/04/yoast_logo_2025_homepage.svg' });
    assert.equal('images' in on.urls[1], false); // a page without images has no empty list
});

test('hreflang extension (gymshark.com)', () => {
    const text = fixture('urlset_gymshark_hreflang_trimmed.xml');
    const r = parseSitemap(text, BASE, { extensions: true });
    assert.equal(r.urls.length, 5);
    assert.equal(r.urls[0].url, 'https://au.gymshark.com/');
    assert.equal(r.urls.reduce((n, u) => n + u.alternates.length, 0), occurrences(text, '<xhtml:link'));
    assert.deepEqual(r.urls[0].alternates[0], { hreflang: 'en-CA', href: 'https://ca.gymshark.com/' });
    assert.equal(parseSitemap(text, BASE).urls[0].alternates, undefined);
});

test('news and image extensions (theguardian.com news sitemap, no XML declaration)', () => {
    const text = fixture('urlset_guardian_news_trimmed.xml');
    const r = parseSitemap(text, BASE, { extensions: true });
    assert.equal(r.kind, 'urlset');
    assert.equal(r.urls.length, 20);
    const first = r.urls[0];
    assert.equal(first.url, 'https://www.theguardian.com/football/2026/nov/14/lamine-yamal-luis-de-la-fuente-spain-england-club-country');
    assert.equal(first.lastmod, '2026-11-14T08:10:00.000Z');
    assert.equal(first.changefreq, 'hourly');
    assert.deepEqual(first.news, [{
        title: 'De la Fuente feels the strain as Lamine Yamal club v country debate rages in Spain',
        publicationName: 'The Guardian',
        language: 'en',
        publicationDate: '2026-11-14T08:00:40.000Z',
    }]);
    assert.equal(first.images[0].url, 'https://i.guim.co.uk/img/media/42e77ccd5533c21e431591604e4275620d0e1cfa/375_0_3803_3043/master/3803.jpg?width=1200&quality=85&auto=format&fit=max&s=8983a6eb1a6ebca18d7b594b6887dd05');
    assert.equal(r.urls.filter((u) => u.news).length, occurrences(text, '<news:news>'));
});

test('parseExtensions: video fields and a namespace prefix on everything', () => {
    const block = `<sm:url><sm:loc>https://a.com/v</sm:loc>
        <video:video><video:thumbnail_loc>https://a.com/t.jpg</video:thumbnail_loc><video:title><![CDATA[A &amp; B]]></video:title>
        <video:description>Desc</video:description><video:content_loc>https://a.com/v.mp4</video:content_loc><video:duration>600</video:duration>
        <video:publication_date>2026-01-02T03:04:05+00:00</video:publication_date></video:video></sm:url>`;
    assert.deepEqual(parseExtensions(block, BASE).videos, [{ title: 'A &amp; B', description: 'Desc', thumbnailUrl: 'https://a.com/t.jpg', contentUrl: 'https://a.com/v.mp4', durationSeconds: 600, publicationDate: '2026-01-02T03:04:05.000Z' }]);
    const r = parseSitemap(`<?xml version="1.0"?><sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">${block}</sm:urlset>`, BASE, { extensions: true });
    assert.equal(r.kind, 'urlset');
    assert.equal(r.urls.length, 1);
    assert.equal(r.urls[0].url, 'https://a.com/v');
    assert.equal(r.urls[0].videos.length, 1);
});

test('text sitemap (xml-sitemaps.com urllist.txt)', () => {
    const text = fixture('sitemap_xmlsitemaps_urllist_trimmed.txt');
    const r = parseSitemap(text, BASE);
    assert.equal(r.kind, 'text');
    assert.equal(r.recognised, true);
    assert.equal(r.urls.length, 40);
    assert.deepEqual(r.urls.map((u) => u.url), text.split('\n').filter(Boolean));
    assert.deepEqual(plain(r.urls[1]), { url: 'https://www.xml-sitemaps.com/about-us.html', lastmod: null, changefreq: null, priority: null });
    const messy = parseSitemap('\uFEFF\r\n# comment\r\nhttps://a.com/1\r\n  https://a.com/2  \r\nnot a url\r\nhttps://a.com/3', BASE);
    assert.deepEqual(messy.urls.map((u) => u.url), ['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
    assert.equal(messy.invalid, 1);
    assert.equal(parseSitemap('404 - Not found', BASE).recognised, false);
    assert.equal(parseSitemap('', BASE).recognised, false);
});

test('gzip files: a .xml.gz (mkdocs.org) and gzip XML served as sitemap.txt (learnenough.com)', () => {
    for (const [name, count] of [['urlset_mkdocs.xml.gz', 19], ['urlset_learnenough_named_txt.gz', 87]]) {
        const raw = bytes(name);
        assert.deepEqual([raw[0], raw[1]], [0x1f, 0x8b], `${name} starts with the gzip magic bytes`);
        const text = zlib.gunzipSync(raw).toString('utf8');
        const r = parseSitemap(text, BASE);
        assert.equal(r.kind, 'urlset');
        assert.equal(r.urls.length, count);
        assert.equal(r.urls.length, occurrences(text, '<url>'));
    }
    const mk = parseSitemap(zlib.gunzipSync(bytes('urlset_mkdocs.xml.gz')).toString('utf8'), BASE).urls[0];
    assert.deepEqual(plain(mk), { url: 'https://www.mkdocs.org/', lastmod: '2024-08-30', changefreq: 'daily', priority: null });
    const le = parseSitemap(zlib.gunzipSync(bytes('urlset_learnenough_named_txt.gz')).toString('utf8'), BASE).urls[0];
    assert.deepEqual(plain(le), { url: 'https://www.learnenough.com', lastmod: '2024-02-22T02:01:20.000Z', changefreq: 'weekly', priority: 1 });
});

test('RSS feed listed as a sitemap (wordpress.org/news/feed), and Atom', () => {
    const r = parseSitemap(fixture('feed_wordpress_news_trimmed.xml'), BASE);
    assert.equal(r.kind, 'rss');
    assert.equal(r.recognised, true);
    assert.deepEqual(r.urls.map(plain), [
        { url: 'https://wordpress.org/news/2026/11/wp-credits-reaches-50/', lastmod: '2026-11-09T16:01:18.000Z', changefreq: null, priority: null },
        { url: 'https://wordpress.org/news/2026/10/critical-php-security-release/', lastmod: '2026-10-21T13:44:09.000Z', changefreq: null, priority: null },
    ]);
    const atom = parseSitemap(`<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><link href="https://a.com/"/>
        <entry><title>One</title><link rel="self" href="https://a.com/1.atom"/><link rel="alternate" type="text/html" href="https://a.com/1?x=1&amp;y=2"/><updated>2026-11-13T08:00:00Z</updated></entry>
        <entry><title>Two</title><link href="https://a.com/2"/><published>2026-11-12</published></entry></feed>`, BASE);
    assert.equal(atom.kind, 'atom');
    assert.deepEqual(atom.urls.map((u) => [u.url, u.lastmod]), [['https://a.com/1?x=1&y=2', '2026-11-13T08:00:00.000Z'], ['https://a.com/2', '2026-11-12']]);
});

test('malformed sitemap: junk before the XML, a missing </url>, a bare &, CDATA, an empty <loc>, a cut-off end', () => {
    const r = parseSitemap(fixture('malformed_sitemaps_org.xml'), 'https://www.sitemaps.org/sitemap.xml');
    assert.equal(r.kind, 'urlset');
    assert.deepEqual(r.urls.map((u) => [u.url, u.lastmod]), [
        ['https://www.sitemaps.org/', '2016-11-21'],
        ['https://www.sitemaps.org/protocol.html', '2022-12-15'], // its </url> is missing
        ['https://www.sitemaps.org/faq.html?a=1&b=2', '2016-11-21'],
        ['https://www.sitemaps.org/terms.html', '2016-11-21'], // CDATA
        ['https://www.sitemaps.org/da/protocol.html', '2022-12-15'],
        ['https://www.sitemaps.org/da/faq.html', '2016-11-21'],
        ['https://www.sitemaps.org/da/terms.html', '2016-11-21'],
        ['https://www.sitemaps.org/de/', '2016-11-21'],
        ['https://www.sitemaps.org/de/protocol.html', '2022-12-15'],
        ['https://www.sitemaps.org/de/faq.html', '2016-11-21'],
        ['https://www.sitemaps.org/de/terms.html', null], // the file ends inside its <lastmod>
    ]);
    assert.equal(r.invalid, 1); // the empty <loc>
});

test('more broken input: no wrapper elements, UTF-8 BOM, HTML, an HTML error page', () => {
    const bare = parseSitemap('\uFEFF<?xml version="1.0"?>\n<urlset>\n<loc>https://a.com/1</loc>\n<loc>https://a.com/2?x=1&amp;y=2</loc>\n<loc>/3</loc>', BASE);
    assert.deepEqual(bare.urls.map((u) => u.url), ['https://a.com/1', 'https://a.com/2?x=1&y=2', 'https://example.test/3']);
    const bareIndex = parseSitemap('<sitemapindex><loc>https://a.com/s1.xml</loc><loc>https://a.com/s2.xml</loc></sitemapindex>', BASE);
    assert.deepEqual(bareIndex.sitemaps.map((s) => s.url), ['https://a.com/s1.xml', 'https://a.com/s2.xml']);
    const html = parseSitemap(fixture('not_sitemap_caniuse_trimmed.html'), BASE);
    assert.equal(html.kind, 'html');
    assert.equal(html.recognised, false);
    assert.equal(html.urls.length, 0);
    const other = parseSitemap('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>', BASE);
    assert.equal(other.kind, 'unknown');
    assert.equal(other.recognised, false);
    const empty = parseSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', BASE);
    assert.equal(empty.recognised, true); // a real sitemap that happens to be empty
    assert.equal(empty.urls.length, 0);
});

test('streaming: any piece size gives the same records as the whole file', () => {
    const files = ['index_yoast.xml', 'urlset_postgresql_trimmed.xml', 'urlset_yoast_page_images_trimmed.xml', 'urlset_gymshark_hreflang_trimmed.xml',
        'urlset_guardian_news_trimmed.xml', 'sitemap_xmlsitemaps_urllist_trimmed.txt', 'feed_wordpress_news_trimmed.xml', 'malformed_sitemaps_org.xml', 'not_sitemap_caniuse_trimmed.html'];
    for (const name of files) {
        const text = fixture(name);
        const whole = parseSitemap(text, BASE, { extensions: true });
        const expected = JSON.stringify([...whole.sitemaps, ...whole.urls]);
        for (const size of [1, 7, 64, 1000, 4096]) {
            const { scanner, records } = inPieces(text, size, { extensions: true });
            assert.equal(JSON.stringify(records), expected, `${name} in pieces of ${size}`);
            assert.equal(scanner.kind, whole.kind);
            assert.equal(scanner.invalid, whole.invalid);
        }
    }
    const bare = '<urlset>\n<loc>https://a.com/1</loc>\n<loc>https://a.com/2</loc>\n<loc>https://a.com/3</loc>\n</urlset>'.padEnd(1500, ' ');
    for (const size of [1, 5, 13, 1024]) assert.equal(inPieces(bare, size).records.length, 3, `bare <loc> in pieces of ${size}`);
});

test('streaming keeps only the unfinished entry in memory', () => {
    const scanner = new SitemapScanner(BASE);
    let total = scanner.push('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n').length;
    let peak = 0;
    for (let i = 0; i < 2000; i++) {
        let piece = '';
        for (let j = 0; j < 100; j++) piece += `<url><loc>https://a.com/page/${i}/${j}</loc><lastmod>2026-01-01</lastmod></url>\n`;
        total += scanner.push(piece.slice(0, 3000)).length + scanner.push(piece.slice(3000)).length;
        peak = Math.max(peak, scanner.buf.length);
    }
    total += scanner.end().length;
    assert.equal(total, 200_000);
    assert.ok(peak < 10_000, `buffer peaked at ${peak} characters`);
});

test('toRow and the guessed paths', () => {
    const rec = parseSitemap(fixture('urlset_guardian_news_trimmed.xml'), BASE, { extensions: true }).urls[0];
    const row = toRow(rec, 'https://www.theguardian.com/sitemaps/news.xml', 'theguardian.com');
    assert.deepEqual(Object.keys(row), ['url', 'lastmod', 'changefreq', 'priority', 'sitemapUrl', 'site', 'images', 'news']);
    assert.equal(row.site, 'theguardian.com');
    const basic = toRow(parseSitemap(fixture('sitemap_xmlsitemaps_urllist_trimmed.txt'), BASE).urls[0], 'https://www.xml-sitemaps.com/urllist.txt', 'https://www.xml-sitemaps.com/urllist.txt');
    assert.deepEqual(basic, { url: 'https://www.xml-sitemaps.com/', lastmod: null, changefreq: null, priority: null, sitemapUrl: 'https://www.xml-sitemaps.com/urllist.txt', site: 'https://www.xml-sitemaps.com/urllist.txt' });
    assert.deepEqual(GUESS_PATHS, ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.txt', '/wp-sitemap.xml']);
});
