#!/usr/bin/env node
/**
 * check-cards.mjs — verify every published page previews as a card, not a bare URL.
 * Static check: the tags a crawler needs, present, absolute, and backed by a real file.
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

  if (errs.length) { console.log(`✗ ${label}\n    ${errs.join('\n    ')}`); fail++; }
  else console.log(`✓ ${label.padEnd(42)} "${(got.get('og:title') || '').slice(0, 38)}" · head @ ${(headEnd / 1024).toFixed(1)} KB`);
}

console.log(fail ? `\n✗ ${fail} page(s) would share as a plain URL` : `\n✓ all ${pages.length} pages carry a full preview card`);
process.exit(fail ? 1 : 0);
