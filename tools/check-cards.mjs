#!/usr/bin/env node
/**
 * check-cards.mjs — verify every published page keeps the promises it makes statically:
 * the tags a crawler needs (present, absolute, backed by a real file), and the model
 * downloads the page offers (present, non-empty, the size the catalog advertises).
 * A download bar pointing at a 404 is the same class of failure as a bare-URL share.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'catalog.json'), 'utf8'));
const REQUIRED = ['og:title', 'og:description', 'og:url', 'og:type', 'og:image'];
const HEAD_BUDGET = 64 * 1024;   // crawlers cap their fetch; tags must land early

let fail = 0;
const pages = [{ label: 'index.html', file: path.join(REPO, 'index.html') },
  ...catalog.worlds.map((w) => ({ label: `w/${w.slug}/`, file: path.join(REPO, 'w', w.slug, 'index.html'), w }))];

for (const { label, file, w } of pages) {
  const errs = [];
  if (!fs.existsSync(file)) { console.log(`✗ ${label} — missing`); fail++; continue; }
  const html = fs.readFileSync(file, 'utf8');
  const head = html.slice(0, html.indexOf('</head>') + 7);

  const got = new Map([...head.matchAll(/<meta\s+(?:property|name)="((?:og|twitter):[a-z:]+)"\s+content="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const k of REQUIRED) if (!got.has(k)) errs.push(`missing ${k}`);
  for (const k of ['og:url', 'og:image']) {
    const v = got.get(k);
    if (v && !/^https?:\/\//.test(v)) errs.push(`${k} not absolute (crawlers reject relative): ${v}`);
  }
  if (got.get('twitter:card') !== 'summary_large_image') errs.push(`twitter:card is "${got.get('twitter:card')}" — want summary_large_image`);

  // og:image must resolve to a file that actually shipped
  const img = got.get('og:image');
  if (img) {
    const rel = img.replace(/^https?:\/\/[^/]+\/[^/]+\//, '');
    const onDisk = path.join(REPO, rel);
    if (!fs.existsSync(onDisk)) errs.push(`og:image has no file on disk: ${rel}`);
    else {
      const kb = fs.statSync(onDisk).size / 1024;
      if (kb > 5120) errs.push(`og:image ${kb.toFixed(0)} KB exceeds the 5 MB crawler cap`);
    }
  }
  const headEnd = html.indexOf('</head>');
  if (headEnd > HEAD_BUDGET) errs.push(`</head> at ${(headEnd / 1024).toFixed(0)} KB — past the ${HEAD_BUDGET / 1024} KB crawler window`);

  // Every download the catalog advertises must exist, be non-empty, match the advertised
  // size (the page prints it on the button), and actually be linked from the page.
  for (const d of (w?.downloads || [])) {
    const onDisk = path.join(REPO, 'w', w.slug, d.file);
    if (!fs.existsSync(onDisk)) { errs.push(`download ${d.file} has no file on disk`); continue; }
    const size = fs.statSync(onDisk).size;
    if (!size) errs.push(`download ${d.file} is empty`);
    else if (size !== d.bytes) errs.push(`download ${d.file} is ${size} B but the catalog advertises ${d.bytes} B — re-publish`);
    if (!html.includes(`href="${d.file}"`)) errs.push(`download ${d.file} is on disk but the page does not link it`);
  }

  if (errs.length) { console.log(`✗ ${label}\n    ${errs.join('\n    ')}`); fail++; }
  else {
    const dl = (w?.downloads || []).map((d) => d.label).join('+');
    console.log(`✓ ${label.padEnd(42)} "${(got.get('og:title') || '').slice(0, 38)}" · head @ ${(headEnd / 1024).toFixed(1)} KB${dl ? ` · ↓ ${dl}` : ''}`);
  }
}

const dlCount = catalog.worlds.reduce((a, w) => a + (w.downloads || []).length, 0);
console.log(fail
  ? `\n✗ ${fail} page(s) would share as a plain URL or offer a broken download`
  : `\n✓ all ${pages.length} pages carry a full preview card${dlCount ? ` · ${dlCount} download(s) present and linked` : ''}`);
process.exit(fail ? 1 : 0);
