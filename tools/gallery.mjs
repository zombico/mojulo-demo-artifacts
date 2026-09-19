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

// A card is a DIV, not one big <a>: the download links are anchors of their own and
// anchors cannot nest. The thumbnail and the title stay links to the world page.
const cards = catalog.worlds.map((w) => {
  const shot = (w.hero || w.card)
    ? `<img loading="lazy" src="${esc(w.hero || w.card)}" alt="">`
    : '<div class="noshot"></div>';
  // On an exhibit the same format exists once per variant, so the button has to say which
  // one it is; a shared file (identical across variants) stays unqualified.
  const vlabel = (key) => (w.variants || []).find((v) => v.key === key)?.label || key;
  const dl = (w.downloads || [])
    .map((d) => `<a href="${esc(d.path)}" download type="${esc(d.mime)}" title="${esc(d.note)}">${esc(d.label)}${d.variant ? ` \u00b7 ${esc(vlabel(d.variant))}` : ''} <i>${mb(d.bytes)}</i></a>`)
    .join('');
  const vr = (w.variants || []).length
    ? `<p class="vr">${w.variants.map((v) => `<b>${esc(v.label)}</b>`).join('')}<span>one model, switch in place</span></p>`
    : '';
  // A world with photographs has been MADE, not just modelled — worth saying on the card.
  const ph = (w.photos || []).length
    ? `<p class="vr"><b class="made">printed</b><span>${w.photos.length} photo${w.photos.length === 1 ? '' : 's'} of the real thing</span></p>`
    : '';
  return `
    <div class="card">
      <a class="shot" href="w/${esc(w.slug)}/">${shot}</a>
      <div class="meta">
        <a class="ttl" href="w/${esc(w.slug)}/"><h2>${esc(w.title)}</h2></a>
        <p class="sub">${esc(w.kind)} · ${mb(w.gzip)} over the wire · recipe ${w.recipeBytes} B</p>
        ${vr}
        ${ph}
        ${dl ? `<p class="dl"><span>take away</span>${dl}</p>` : ''}
      </div>
    </div>`;
}).join('');

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
  .card { display:block; background:#11151d; border:1px solid var(--line); border-radius:11px; overflow:hidden; transition:border-color .15s, transform .15s; }
  .card:hover { border-color:#39506b; transform:translateY(-2px); }
  .card a { text-decoration:none; color:inherit; }
  .shot { display:block; }
  .card img, .noshot { width:100%; aspect-ratio:1200/630; object-fit:cover; display:block; background:linear-gradient(135deg,#151b25,#0e1219); }
  .meta { padding:13px 15px 15px; }
  h2 { margin:0 0 5px; font-size:14.5px; font-weight:600; line-height:1.35; }
  .ttl:hover h2 { color:var(--accent); }
  .sub { margin:0; font-size:12px; color:var(--dim); }
  .vr { margin:9px 0 0; display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:12px; }
  .vr b { font-weight:500; color:var(--fg); border:1px solid var(--line); border-radius:4px; padding:2px 7px; background:#0d1118; font-size:11.5px; }
  .vr span { color:var(--dim); font-size:11px; }
  .vr b.made { color:#ffb4a2; border-color:#5a3a34; background:#1c1311; }
  .dl { margin:11px 0 0; display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:12px; }
  .dl span { color:var(--dim); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; }
  .dl a { display:inline-flex; align-items:center; gap:5px; color:var(--accent); border:1px solid var(--line); border-radius:5px; padding:4px 8px; background:#0d1118; }
  .dl a:hover { border-color:#39506b; background:#161d29; }
  .dl a i { color:var(--dim); font-style:normal; font-size:11px; }
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
