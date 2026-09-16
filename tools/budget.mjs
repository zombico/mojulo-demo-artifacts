#!/usr/bin/env node
/** budget.mjs — audit the site against the GitHub Pages ceilings. */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SITE_LIMIT = 1073741824;          // 1 GB published-site hard limit
const BANDWIDTH = 100 * 1073741824;     // 100 GB/month soft limit
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

let bytes = 0, files = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.github'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else { bytes += fs.statSync(p).size; files++; }
  }
};
walk(REPO);

const catalog = fs.existsSync(path.join(REPO, 'catalog.json'))
  ? JSON.parse(fs.readFileSync(path.join(REPO, 'catalog.json'), 'utf8')) : { worlds: [] };
const n = catalog.worlds.length;
const wire = catalog.worlds.reduce((a, w) => a + w.gzip, 0);
const avgDisk = n ? bytes / n : 0;
const avgWire = n ? wire / n : 0;

console.log(`site         ${mb(bytes)} across ${files} files · ${n} worlds`);
console.log(`ceiling      ${(100 * bytes / SITE_LIMIT).toFixed(1)}% of the 1 GB published-site limit`);
if (n) {
  console.log(`per world    ${mb(avgDisk)} on disk · ${mb(avgWire)} served (gzip)`);
  console.log(`headroom     room for ~${Math.max(0, Math.floor((SITE_LIMIT - bytes) / avgDisk))} more at this average`);
  console.log(`bandwidth    ~${Math.floor(BANDWIDTH / avgWire).toLocaleString()} views/month before the 100 GB soft limit`);
}
console.log(`\nheaviest:`);
for (const w of [...catalog.worlds].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
  console.log(`  ${mb(w.bytes).padStart(9)} on disk · ${mb(w.gzip).padStart(9)} served   w/${w.slug}`);
}
if (bytes > SITE_LIMIT) { console.error('\n✗ OVER the 1 GB Pages limit'); process.exit(1); }
if (bytes > SITE_LIMIT * 0.8) console.warn('\n⚠ over 80% of the ceiling');
