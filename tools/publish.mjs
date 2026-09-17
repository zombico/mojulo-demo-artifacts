#!/usr/bin/env node
/**
 * publish.mjs — bake a mojulo sketch into a shareable static world page.
 *
 *   node tools/publish.mjs <ref> [<ref>...] [--slug <name>] [--control <path>]
 *                          [--base <url>] [--no-card] [--downloads glb,stl]
 *
 * Worlds are baked HERE, on the operator's host, because resolving one needs the
 * local sketches DB and the graph library. CI never sees the DB; it only uploads
 * what was committed. The emitted page uses the CDN importmap (`cdn: true`), so
 * three.js comes from jsdelivr and is cached once across every world on the site
 * (86 KB gzip) instead of being inlined into each page (~365 KB raw, every time).
 *
 * SOCIAL CARDS. Pages is static and link crawlers do not execute JavaScript, so
 * Open Graph tags cannot be injected at request time or from the client — they are
 * baked into each page's <head> here, at publish time. The emitted <head> is ~1.7 KB
 * of a ~2.8 MB page, so the tags sit in the first 0.1% of the file and survive
 * crawlers that fetch only the first chunk (Slack, Discord and Twitter all cap).
 * og:image must be an ABSOLUTE url, which is why --base exists.
 *
 * DOWNLOADS. `--downloads glb,stl` writes the exported model beside the page and
 * puts a download bar on it, so a world can be TAKEN AWAY and not only looked at.
 * The files come off the same resolved payload the page renders — one bake, one
 * geometry, so the download is the thing on screen rather than a re-export that
 * might drift. They are committed assets: budget them (see `node tools/budget.mjs`),
 * since a GLB + STL pair roughly doubles a small world's footprint.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');

// ── args ──────────────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['slug', 'control', 'base', 'downloads']);
const argv = process.argv.slice(2);
const opts = {};
const refs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) opts[name] = argv[++i];
    else opts[name] = true;
  } else refs.push(a);
}
if (!refs.length) {
  console.error('usage: node tools/publish.mjs <sketch-ref> [...] [--slug name] [--control path] [--base url] [--no-card] [--downloads glb,stl]');
  process.exit(1);
}

// Downloadable model formats. Two, deliberately: GLB is the faithful depiction (vertex
// colours, named groups — what the page shows), STL is the printing handoff (triangle
// soup, colour dropped, scaled to millimetres). Both come from the page's own payload.
const FORMATS = {
  glb: { ext: 'glb', label: 'GLB', mime: 'model/gltf-binary', note: 'vertex colours + named groups — opens in Blender, three.js, Windows 3D Viewer' },
  stl: { ext: 'stl', label: 'STL', mime: 'model/stl', note: 'binary triangle soup for slicers — colour dropped, scaled to millimetres' },
};
const WANT_DOWNLOADS = typeof opts.downloads === 'string'
  ? opts.downloads.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  : [];
for (const f of WANT_DOWNLOADS) {
  if (!FORMATS[f]) {
    console.error(`✗ --downloads: unknown format '${f}' — pick from ${Object.keys(FORMATS).join(', ')}`);
    process.exit(1);
  }
}

const CONTROL = path.resolve(opts.control || process.env.MOJULO_CONTROL || path.join(REPO, '..', 'mojulo', 'control'));
if (!fs.existsSync(path.join(CONTROL, 'package.json'))) {
  console.error(`✗ mojulo control plane not found at ${CONTROL}\n  pass --control /path/to/mojulo/control`);
  process.exit(1);
}

const catalogPath = path.join(REPO, 'catalog.json');
const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { worlds: [] };
// The site base sticks in the catalog once set, so later publishes inherit it.
const BASE = String(opts.base || process.env.MOJULO_PAGES_BASE || catalog.site || 'https://zombico.github.io/mojulo-demo-artifacts').replace(/\/+$/, '');
catalog.site = BASE;
const WANT_CARD = !opts['no-card'];

// The graph library resolves `@/` and reads package.json from cwd, so run as if from control/.
process.chdir(CONTROL);
process.env.MOJULO_DATA_DIR ||= path.join(CONTROL, 'data');
process.env.MOJULO_OUTCOMES_DIR ||= path.join(CONTROL, 'data', 'outcomes');
register('./mcp-stdio-loader.mjs', pathToFileURL(path.join(CONTROL, 'scripts/')));

const { SketchRepository } = await import('@/lib/db/repositories/sketches');
const { emitThreeWorld } = await import('@/lib/graph/scene/scene-three');
const { resolveWorldScene } = await import('@/lib/graph/worlds/world-scene');
// The export seam, shared with mojulo's own export_model tool — same functions, same
// bytes. `resolvePrintScale` is what turns a recipe's declared units into millimetres,
// so an STL lands at true size in a slicer instead of at an arbitrary scale.
const { facesToGlb } = WANT_DOWNLOADS.includes('glb') ? await import('@/lib/graph/scene/scene-gltf') : {};
const { facesToStl } = WANT_DOWNLOADS.includes('stl') ? await import('@/lib/graph/scene/scene-stl') : {};
const { printProfileFor, resolvePrintScale } = WANT_DOWNLOADS.includes('stl') ? await import('@/lib/mcp/tools/sketch-model-export') : {};
const { declaredUnits } = WANT_DOWNLOADS.includes('stl') ? await import('@/lib/graph/scene/world-units') : {};

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const sz = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

// Open Graph card sizing is a de-facto standard: 1200×630, under 5 MB, absolute url.
const CARD_W = 1200, CARD_H = 630;

/** Describe the world in one sentence, for the card body. */
function describe(sketch, kind) {
  const note = typeof sketch.manifest?.note === 'string' ? sketch.manifest.note.split('·')[0].trim() : '';
  const verb = kind === 'floorplan' ? 'Walk and fly through' : 'Orbit, zoom and walk';
  const base = note && note.length > 12 ? note : `${verb} this world in your browser — no install.`;
  return base.length > 180 ? base.slice(0, 177) + '…' : base;
}

/** Bake OG/Twitter tags into the emitted <head>, immediately after </title>. */
function injectCard(html, { title, description, url, image }) {
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta name="theme-color" content="#0b1220">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="mojulo — demo artifacts">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    ...(image ? [
      `<meta property="og:image" content="${esc(image)}">`,
      `<meta property="og:image:type" content="image/jpeg">`,
      `<meta property="og:image:width" content="${CARD_W}">`,
      `<meta property="og:image:height" content="${CARD_H}">`,
      `<meta property="og:image:alt" content="${esc(title)}">`,
    ] : []),
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    ...(image ? [`<meta name="twitter:image" content="${esc(image)}">`] : []),
  ].join('\n');
  const at = html.indexOf('</title>');
  if (at === -1) return html.replace('<head>', `<head>\n${tags}`);
  return html.slice(0, at + 8) + '\n' + tags + html.slice(at + 8);
}

/**
 * Write the downloadable models beside the page, off the payload the page itself renders.
 * Returns one entry per format for the catalog and the download bar.
 *
 * STL carries no units, so slicers assume millimetres — the recipe's declared units decide
 * the scale (this world says `cm`, so ×10) and the printed size is reported in the tooltip.
 * GLB needs no such conversion: it declares its own scale.
 */
function writeDownloads(dir, slug, ref, payload, kind, manifest, formats) {
  const out = [];
  for (const f of formats) {
    const spec = FORMATS[f];
    let exported = null;
    let detail = spec.note;
    try {
      if (f === 'glb') {
        exported = facesToGlb(payload, { generator: `mojulo ${ref}` });
      } else if (f === 'stl') {
        const declared = declaredUnits(manifest);
        const { scale, scaleNote } = resolvePrintScale({
          payload, profile: printProfileFor(kind ?? manifest.kind), units: declared ? declared.units : null,
        });
        exported = facesToStl(payload, { scale, generator: `mojulo ${ref}` });
        if (exported?.bounds?.size) {
          const dims = exported.bounds.size.map((n) => Math.round(n)).join(' × ');
          detail = `${spec.note} — prints ${dims} mm (${scaleNote})`;
        }
      }
    } catch (e) { console.error(`  ↳ ${spec.label} skipped: ${e.message}`); continue; }
    if (!exported?.bytes) { console.error(`  ↳ ${spec.label} skipped: nothing printable in this world`); continue; }

    const name = `model.${spec.ext}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(exported.bytes));
    out.push({
      format: f, label: spec.label, file: name, path: `w/${slug}/${name}`,
      bytes: exported.byteLength, mime: spec.mime, note: detail,
      triangles: exported.triangleCount ?? null,
    });
  }
  return out;
}

/**
 * Put the download bar on the page. The page is a viewer; this is what you take away.
 * Injected at bake time like the card tags — the emitted world page has no notion of
 * sibling files, and Pages is static, so nothing can add these at request time.
 */
function injectDownloads(html, downloads) {
  if (!downloads.length) return html;
  const style = `<style>
  .dl{position:absolute;right:8px;top:8px;display:flex;align-items:center;gap:6px;z-index:6;font:12px/1 system-ui,sans-serif}
  .dl>span{color:#6f86ad;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .dl a{display:flex;align-items:center;gap:6px;color:#9cc4ff;background:rgba(11,18,32,.72);border:1px solid #24324a;border-radius:5px;padding:5px 9px;text-decoration:none}
  .dl a:hover{background:#1b2740;color:#fff;border-color:#39506b}
  .dl a i{color:#6f86ad;font-style:normal;font-size:11px}
  @media (max-width:640px){.dl>span{display:none}}
</style>`;
  const links = downloads.map((d) => `<a href="${esc(d.file)}" download type="${esc(d.mime)}" title="${esc(d.note)}">${esc(d.label)} <i>${sz(d.bytes)}</i></a>`).join('');
  const bar = `<div class="dl"><span>download</span>${links}</div>`;
  const withStyle = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : html;
  const anchor = '<canvas id="c"></canvas>';
  return withStyle.includes(anchor) ? withStyle.replace(anchor, `${anchor}\n    ${bar}`) : withStyle;
}

/** Screenshot the baked page at card size. Served over http — file:// blocks ES modules. */
async function captureCard(dir) {
  const require = createRequire(path.join(CONTROL, 'package.json'));
  const puppeteer = (await import(pathToFileURL(require.resolve('puppeteer-core')).href)).default;
  const { resolveChromium, CHROMIUM_WEBGL_ARGS } = await import('@/lib/graph/scene/chromium');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(dir, 'index.html')).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: await resolveChromium(), headless: true, args: CHROMIUM_WEBGL_ARGS });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: CARD_W, height: CARD_H });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle2', timeout: 180000 });
    await new Promise((r) => setTimeout(r, 7000));
    // The card is a picture of the WORLD, not of the viewer — drop the interactive chrome.
    // The emitted page pins #wrap to a fixed 1120x780, so a 630-tall viewport would simply
    // CLIP the subject. Force the wrap to card size and let the page's own resize() re-frame
    // the camera (vertical fov is preserved, so nothing is cut off vertically).
    await page.addStyleTag({ content: `.hud,.hint,.moj-readout,.dl{display:none!important}
      body{display:block!important;margin:0!important}
      #wrap{width:${CARD_W}px!important;height:${CARD_H}px!important;max-width:none!important;aspect-ratio:auto!important}` });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(dir, 'card.jpg'), type: 'jpeg', quality: 78 });
  } finally { await browser.close(); server.close(); }
  return fs.statSync(path.join(dir, 'card.jpg')).size;
}

// ── bake ──────────────────────────────────────────────────────────────────────
for (const ref of refs) {
  const sketch = SketchRepository.getByRef(ref);
  if (!sketch) { console.error(`✗ ${ref} — no such sketch`); continue; }

  const t0 = Date.now();
  let resolved;
  try { resolved = await resolveWorldScene(sketch, {}); }
  catch (e) { console.error(`✗ ${ref} — resolve failed: ${e.message}`); continue; }
  if (!resolved?.payload) { console.error(`✗ ${ref} — not world-eligible (kind has no traversable world)`); continue; }

  const slug = (refs.length === 1 && typeof opts.slug === 'string' ? opts.slug : null) || slugify(ref);
  const dir = path.join(REPO, 'w', slug);
  fs.mkdirSync(dir, { recursive: true });

  const title = sketch.title || ref;
  const description = describe(sketch, resolved.kind);
  const url = `${BASE}/w/${slug}/`;

  // A Blender Cycles hero (tools/render-hero.mjs) outranks the WebGL screenshot: if one is
  // already committed for this slug, use it as og:image and skip the capture entirely.
  // --recard forces a fresh WebGL card even when a hero exists.
  const heroPath = path.join(dir, 'hero.jpg');
  const hasHero = fs.existsSync(heroPath) && !opts.recard;
  const heroBytes = hasHero ? fs.statSync(heroPath).size : 0;

  // Models first: the download bar has to know each file's real size, and the bar is part
  // of every bake below (including the one the card is shot from, where CSS hides it).
  // A world that already offers downloads keeps them on a re-publish without the flag —
  // re-exported, never carried over, so the file and the page never drift apart.
  const prior = catalog.worlds.find((w) => w.slug === slug);
  const formats = WANT_DOWNLOADS.length
    ? WANT_DOWNLOADS
    : (prior?.downloads || []).map((d) => d.format).filter((f) => FORMATS[f]);
  const downloads = formats.length
    ? writeDownloads(dir, slug, ref, resolved.payload, resolved.kind, sketch.manifest, formats)
    : [];

  // Bake once WITHOUT the card image, capture from that page, then re-inject with it.
  // The screenshot is of the world itself, so it cannot reference its own url.
  const bake = (image) => injectDownloads(
    injectCard(emitThreeWorld({ ...resolved.payload, cdn: true }), { title, description, url, image }),
    downloads,
  );
  let html = bake(hasHero ? `${url}hero.jpg` : null);
  fs.writeFileSync(path.join(dir, 'index.html'), html);

  let cardBytes = fs.existsSync(path.join(dir, 'card.jpg')) ? fs.statSync(path.join(dir, 'card.jpg')).size : 0;
  if (WANT_CARD && !hasHero) {
    try {
      cardBytes = await captureCard(dir);
      html = bake(`${url}card.jpg`);
      fs.writeFileSync(path.join(dir, 'index.html'), html);
    } catch (e) { console.error(`  \u21b3 card skipped: ${e.message}`); }
  }

  // Downloads count against the 1 GB ceiling like any other committed file, so they ride
  // in `bytes`. They are NOT in `gzip`: that figure is what a VISIT costs, and a download
  // is a second, opt-in request — folding it in would overstate the cost of looking.
  const downloadBytes = downloads.reduce((a, d) => a + d.bytes, 0);
  const bytes = Buffer.byteLength(html) + cardBytes + heroBytes + downloadBytes;
  const gzip = zlib.gzipSync(Buffer.from(html), { level: 9 }).length;   // what Pages actually serves
  const entry = {
    slug, ref, title, description,
    kind: resolved.kind,
    url,
    card: cardBytes ? `w/${slug}/card.jpg` : null,
    hero: hasHero ? `w/${slug}/hero.jpg` : null,
    ...(downloads.length ? { downloads } : {}),
    bytes, gzip,
    recipeBytes: Buffer.byteLength(JSON.stringify(sketch.manifest)),
    bakedAt: new Date().toISOString().slice(0, 10),
  };
  const i = catalog.worlds.findIndex((w) => w.slug === slug);
  if (i === -1) catalog.worlds.push(entry); else catalog.worlds[i] = entry;

  console.log(`✓ w/${slug}/  ${mb(bytes)} on disk · ${mb(gzip)} over the wire · recipe ${entry.recipeBytes} B · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (hasHero) console.log(`  \u21b3 hero.jpg ${Math.round(heroBytes / 1024)} KB (cycles) · og:image ${url}hero.jpg`);
  else if (cardBytes) console.log(`  \u21b3 card.jpg ${Math.round(cardBytes / 1024)} KB · og:image ${url}card.jpg`);
  for (const d of downloads) console.log(`  \u21b3 ${d.file.padEnd(9)} ${sz(d.bytes).padStart(7)} · ${d.note}`);
}

catalog.worlds.sort((a, b) => a.slug.localeCompare(b.slug));
catalog.updatedAt = new Date().toISOString();
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');

const total = catalog.worlds.reduce((a, w) => a + w.bytes, 0);
console.log(`\ncatalog: ${catalog.worlds.length} worlds · ${mb(total)} of the 1024 MB Pages ceiling (${(100 * total / 1073741824).toFixed(1)}%)`);
