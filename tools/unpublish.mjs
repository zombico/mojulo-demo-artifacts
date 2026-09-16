#!/usr/bin/env node
/** unpublish.mjs — drop a published world: its directory and its catalog entry. */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const slugs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!slugs.length) { console.error('usage: node tools/unpublish.mjs <slug> [<slug>...]'); process.exit(1); }

const catalogPath = path.join(REPO, 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

let dropped = 0;
for (const slug of slugs) {
  const i = catalog.worlds.findIndex((w) => w.slug === slug);
  const dir = path.join(REPO, 'w', slug);
  const onDisk = fs.existsSync(dir);
  if (i === -1 && !onDisk) { console.error(`✗ ${slug} — not published`); continue; }
  if (onDisk) fs.rmSync(dir, { recursive: true, force: true });
  if (i !== -1) catalog.worlds.splice(i, 1);
  console.log(`✓ removed w/${slug}/`);
  dropped++;
}

if (dropped) {
  catalog.updatedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`\ncatalog: ${catalog.worlds.length} worlds — run tools/gallery.mjs to refresh the index`);
}
