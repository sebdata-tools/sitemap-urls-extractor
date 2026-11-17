// Live smoke test: runs the Actor locally with a given input and prints a summary of what it saved.
// Usage (from the Actor folder): node test/run_local.mjs @file.json [rows to print]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] ?? '{"sites":["https://www.sitemaps.org"],"maxUrlsPerSite":100}';
const input = JSON.parse(arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg);

const storage = path.join(root, 'storage');
fs.rmSync(storage, { recursive: true, force: true });
const kv = path.join(storage, 'key_value_stores', 'default');
fs.mkdirSync(kv, { recursive: true });
fs.writeFileSync(path.join(kv, 'INPUT.json'), JSON.stringify(input));

const t0 = Date.now();
const run = spawnSync(process.execPath, ['src/main.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, APIFY_LOCAL_STORAGE_DIR: storage } });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

const dsDir = path.join(storage, 'datasets', 'default');
const files = fs.existsSync(dsDir) ? fs.readdirSync(dsDir).filter((f) => /^\d+\.json$/.test(f)).sort() : [];
const items = files.map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8')));
const count = (fn) => items.filter(fn).length;
const perSite = {};
const perFile = {};
for (const it of items) {
    perSite[it.site] = (perSite[it.site] ?? 0) + 1;
    perFile[it.sitemapUrl] = (perFile[it.sitemapUrl] ?? 0) + 1;
}
console.log('\n=== exit code', run.status, '| seconds', seconds, '| items', items.length, '| per site', JSON.stringify(perSite),
    '| distinct site+url', new Set(items.map((i) => `${i.site}|${i.url}`)).size,
    '| sitemap files with rows', Object.keys(perFile).length,
    '| with lastmod', count((i) => i.lastmod), '| with changefreq', count((i) => i.changefreq), '| with priority', count((i) => typeof i.priority === 'number'),
    '| with images', count((i) => i.images), '| with videos', count((i) => i.videos), '| with news', count((i) => i.news), '| with alternates', count((i) => i.alternates),
    '| not http(s)', count((i) => !/^https?:\/\//i.test(i.url)));
const summaryFile = path.join(kv, 'SUMMARY.json');
if (fs.existsSync(summaryFile)) console.log('SUMMARY', JSON.stringify(JSON.parse(fs.readFileSync(summaryFile, 'utf8'))));
const shown = new Set();
let left = Number(process.argv[3] ?? 2);
for (const it of items) { // the first row of each site, up to the number asked for
    if (left <= 0) break;
    if (shown.has(it.site)) continue;
    shown.add(it.site);
    left--;
    console.log(JSON.stringify(it).slice(0, 1500));
}
fs.writeFileSync(path.join(storage, 'per_file.json'), JSON.stringify(perFile, null, 1));
fs.writeFileSync(path.join(storage, 'items.json'), JSON.stringify(items));
process.exit(run.status ?? 1);
