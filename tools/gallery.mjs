#!/usr/bin/env node
/** gallery.mjs — regenerate index.html from catalog.json. Pure function of the catalog. */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'catalog.json'), 'utf8'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

const BASE = String(catalog.site || 'https://zombico.github.io/mojulo-demo-artifacts').replace(/\/+$/, '');
const SITE_TITLE = 'mojulo — demo artifacts';
const SITE_DESC = `${catalog.worlds.length} shareable 3D worlds, each baked from a tiny deterministic mojulo recipe — orbit, zoom and walk them in the browser, no install.`;
const heroCard = catalog.worlds.find((w) => w.hero)?.hero || catalog.worlds.find((w) => w.card)?.card;

const total = catalog.worlds.reduce((a, w) => a + w.bytes, 0);
const wire = catalog.worlds.reduce((a, w) => a + w.gzip, 0);
const pct = (100 * total / 1073741824).toFixed(1);

const cards = catalog.worlds.map((w) => `
    <a class="card" href="w/${esc(w.slug)}/">
      ${(w.hero || w.card) ? `<img loading="lazy" src="${esc(w.hero || w.card)}" alt="">` : '<div class="noshot"></div>'}
      <div class="meta">
        <h2>${esc(w.title)}</h2>
        <p class="sub">${esc(w.kind)} · ${mb(w.gzip)} over the wire · recipe ${w.recipeBytes} B</p>
      </div>
    </a>`).join('');

fs.writeFileSync(path.join(REPO, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>mojulo — demo artifacts</title>
<link rel="canonical" href="${BASE}/">
<meta name="description" content="${esc(SITE_DESC)}">
<meta name="theme-color" content="#0b0d12">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE_TITLE)}">
<meta property="og:title" content="${esc(SITE_TITLE)}">
<meta property="og:description" content="${esc(SITE_DESC)}">
<meta property="og:url" content="${BASE}/">
${heroCard ? `<meta property="og:image" content="${BASE}/${heroCard}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(SITE_TITLE)}">` : ''}
<meta name="twitter:card" content="${heroCard ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(SITE_TITLE)}">
<meta name="twitter:description" content="${esc(SITE_DESC)}">
${heroCard ? `<meta name="twitter:image" content="${BASE}/${heroCard}">` : ''}
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --fg:#e8ecf3; --dim:#8b95a7; --line:#1e232e; --accent:#7fd4ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:48px 24px 28px; max-width:1180px; margin:0 auto; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 8px; font-size:26px; letter-spacing:-.02em; font-weight:650; }
  header p { margin:0; color:var(--dim); max-width:62ch; }
  .budget { margin-top:20px; font-size:13px; color:var(--dim); }
  .bar { height:5px; background:var(--line); border-radius:3px; overflow:hidden; margin-top:7px; max-width:420px; }
  .bar i { display:block; height:100%; background:var(--accent); width:${Math.min(100, pct)}%; }
  main { max-width:1180px; margin:0 auto; padding:28px 24px 72px; }
  .grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); }
  .card { display:block; text-decoration:none; color:inherit; background:#11151d; border:1px solid var(--line); border-radius:11px; overflow:hidden; transition:border-color .15s, transform .15s; }
  .card:hover { border-color:#39506b; transform:translateY(-2px); }
  .card img, .noshot { width:100%; aspect-ratio:1200/630; object-fit:cover; display:block; background:linear-gradient(135deg,#151b25,#0e1219); }
  .meta { padding:13px 15px 15px; }
  h2 { margin:0 0 5px; font-size:14.5px; font-weight:600; line-height:1.35; }
  .sub { margin:0; font-size:12px; color:var(--dim); }
  .empty { color:var(--dim); padding:40px 0; }
  footer { max-width:1180px; margin:0 auto; padding:0 24px 56px; color:var(--dim); font-size:12.5px; }
  code { background:#161b24; padding:1px 5px; border-radius:4px; font-size:12px; }
</style></head>
<body>
<header>
  <h1>mojulo — demo artifacts</h1>
  <p>Shareable 3D worlds. Each one is baked from a tiny deterministic mojulo recipe and served as a
     self-contained page — orbit, zoom and walk it in the browser, no install.</p>
  <div class="budget">
    ${catalog.worlds.length} world${catalog.worlds.length === 1 ? '' : 's'} ·
    ${mb(total)} on disk of the 1 GB Pages ceiling (${pct}%) · ${mb(wire)} total over the wire
    <div class="bar"><i></i></div>
  </div>
</header>
<main>
  ${catalog.worlds.length ? `<div class="grid">${cards}\n  </div>` : '<p class="empty">No worlds published yet. Run <code>node tools/publish.mjs &lt;sketch-ref&gt;</code>.</p>'}
</main>
<footer>Baked with <a style="color:var(--accent)" href="https://github.com/zombico/mojulo">mojulo</a>. three.js loads from jsdelivr, cached once across every world.</footer>
</body></html>
`);
console.log(`✓ index.html — ${catalog.worlds.length} worlds · ${mb(total)} on disk (${pct}% of ceiling)`);
