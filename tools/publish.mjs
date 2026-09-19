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
import crypto from 'node:crypto';
import http from 'node:http';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');

// ── args ──────────────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['slug', 'control', 'base', 'downloads', 'labels', 'title', 'photos', 'captions', 'hero-from']);
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
  console.error('usage: node tools/publish.mjs <sketch-ref> [...] [--slug name] [--control path] [--base url]\n'
    + '                             [--no-card] [--downloads glb,stl] [--consolidate [--labels A,B] [--title t]]');
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

// --consolidate: the positional refs are VARIANTS of one exhibit, not separate worlds.
// They must share their geometry (fuseVariants asserts it); only their colours may differ.
const CONSOLIDATE = !!opts.consolidate;
if (CONSOLIDATE && refs.length < 2) {
  console.error('\u2717 --consolidate needs two or more refs — that is what it consolidates');
  process.exit(1);
}
const LABELS = typeof opts.labels === 'string' ? opts.labels.split(',').map((x) => x.trim()) : [];
if (LABELS.length && LABELS.length !== refs.length) {
  console.error(`\u2717 --labels has ${LABELS.length} entr${LABELS.length === 1 ? 'y' : 'ies'} for ${refs.length} refs`);
  process.exit(1);
}

// --photos: real photographs of the thing the recipe describes (a print, a build), shown
// under the viewer. A directory is taken in name order; a comma list keeps the order given,
// which is how a sequence (on the bed \u2192 detail \u2192 in use) is authored.
function resolvePhotoSources(arg) {
  if (typeof arg !== 'string' || !arg) return [];
  if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
    return fs.readdirSync(arg).filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f)).sort()
      .map((f) => path.join(arg, f));
  }
  return arg.split(',').map((x) => x.trim()).filter(Boolean);
}
const PHOTOS = resolvePhotoSources(opts.photos);
for (const f of PHOTOS) {
  if (!fs.existsSync(f)) { console.error(`\u2717 --photos: no such file \u2014 ${f}`); process.exit(1); }
}
const CAPTIONS = typeof opts.captions === 'string' ? opts.captions.split('|').map((x) => x.trim()) : [];
if (CAPTIONS.length && CAPTIONS.length !== PHOTOS.length) {
  console.error(`\u2717 --captions has ${CAPTIONS.length} for ${PHOTOS.length} photos`);
  process.exit(1);
}
if (typeof opts['hero-from'] === 'string' && !fs.existsSync(opts['hero-from'])) {
  console.error(`\u2717 --hero-from: no such file \u2014 ${opts['hero-from']}`);
  process.exit(1);
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
 * Export ONE model file's bytes for one variant. Split out of the writer because a
 * consolidated exhibit exports the same format once per variant and then has to decide
 * whether those results are actually different files.
 *
 * STL carries no units, so slicers assume millimetres — the recipe's declared units decide
 * the scale (this world says `cm`, so ×10) and the printed size is reported in the tooltip.
 * GLB needs no such conversion: it declares its own scale.
 */
function exportModel(format, { payload, kind, manifest }, generator) {
  const spec = FORMATS[format];
  if (format === 'glb') {
    const e = facesToGlb(payload, { generator });
    return e?.bytes ? { bytes: e.bytes, byteLength: e.byteLength, triangles: e.triangleCount ?? null, note: spec.note } : null;
  }
  const declared = declaredUnits(manifest);
  const { scale, scaleNote } = resolvePrintScale({
    payload, profile: printProfileFor(kind ?? manifest.kind), units: declared ? declared.units : null,
  });
  const e = facesToStl(payload, { scale, generator });
  if (!e?.bytes) return null;
  const dims = e.bounds?.size ? e.bounds.size.map((n) => Math.round(n)).join(' × ') : null;
  return {
    bytes: e.bytes, byteLength: e.byteLength, triangles: e.triangleCount ?? null,
    note: dims ? `${spec.note} — prints ${dims} mm (${scaleNote})` : spec.note,
  };
}

/**
 * Write the downloadable models beside the page, off the payloads the page itself renders.
 *
 * With one variant this is just `model.<ext>`. With several, a format is exported once per
 * variant and the RESULTS decide the filenames: variants that differ get one file each
 * (`model-<key>.<ext>`), variants that produce identical bytes collapse to a single shared
 * `model.<ext>`. That is not a size optimisation — it is honesty. The toon variant re-bakes
 * colour only, so its STL (geometry, colour dropped) is byte-identical to the standard one,
 * and offering it twice under two names would claim a difference that does not exist.
 */
function writeDownloads(dir, slug, variants, formats) {
  const out = [];
  for (const f of formats) {
    const spec = FORMATS[f];
    // Compare with ONE generator string for every variant. That string is provenance and it
    // embeds the ref, so exporting each variant under its own name would make two identical
    // meshes hash differently and defeat the dedupe — the STL case exactly.
    const neutral = `mojulo ${slug}`;
    const built = [];
    for (const v of variants) {
      let e = null;
      try { e = exportModel(f, v, neutral); }
      catch (err) { console.error(`  \u21b3 ${spec.label} (${v.label}) skipped: ${err.message}`); continue; }
      if (!e) { console.error(`  \u21b3 ${spec.label} (${v.label}) skipped: nothing printable in this world`); continue; }
      built.push({ v, e, sha: crypto.createHash('sha256').update(Buffer.from(e.bytes)).digest('hex') });
    }
    if (!built.length) continue;

    const shared = built.every((b) => b.sha === built[0].sha);
    // A per-variant file is re-exported under its own ref, so the file says which sketch it
    // came from. A shared file keeps the exhibit-level generator, because it came from all.
    if (!shared) {
      for (const b of built) {
        const e = exportModel(f, b.v, `mojulo ${b.v.ref}`);
        if (e) b.e = e;
      }
    } else if (variants.length === 1) {
      const e = exportModel(f, built[0].v, `mojulo ${built[0].v.ref}`);
      if (e) built[0].e = e;
    }
    const emit = (name, b, variantKey) => {
      fs.writeFileSync(path.join(dir, name), Buffer.from(b.e.bytes));
      out.push({
        format: f, label: spec.label, file: name, path: `w/${slug}/${name}`,
        bytes: b.e.byteLength, mime: spec.mime, triangles: b.e.triangles,
        ...(variantKey ? { variant: variantKey } : {}),
        note: shared && variants.length > 1
          ? `${b.e.note} — identical for every variant (geometry is shared)`
          : b.e.note,
      });
    };
    if (shared) emit(`model.${spec.ext}`, built[0], null);
    else for (const b of built) emit(`model-${b.v.key}.${spec.ext}`, b, b.v.key);
  }
  return out;
}

/**
 * Put the download bar on the page. The page is a viewer; this is what you take away.
 * Injected at bake time like the card tags — the emitted world page has no notion of
 * sibling files, and Pages is static, so nothing can add these at request time.
 *
 * A per-variant file carries `data-v` and is shown only while that variant is active, so
 * the bar always offers the file matching what is on screen. Both links are in the markup
 * either way (CSS does the hiding), which keeps them discoverable and lets check-cards
 * verify every advertised file is really linked.
 */
function injectDownloads(html, downloads, variants) {
  if (!downloads.length) return html;
  const perVariant = downloads.some((d) => d.variant);
  const style = `<style>
  .dl{position:absolute;right:8px;top:8px;display:flex;align-items:center;gap:6px;z-index:6;font:12px/1 system-ui,sans-serif}
  .dl>span{color:#6f86ad;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .dl a{display:flex;align-items:center;gap:6px;color:#9cc4ff;background:rgba(11,18,32,.72);border:1px solid #24324a;border-radius:5px;padding:5px 9px;text-decoration:none}
  .dl a:hover{background:#1b2740;color:#fff;border-color:#39506b}
  .dl a i{color:#6f86ad;font-style:normal;font-size:11px}
  @media (max-width:640px){.dl>span{display:none}}${perVariant ? `
  .dl a[data-v]{display:none}
${variants.map((v) => `  #wrap[data-variant="${v.key}"] .dl a[data-v="${v.key}"]{display:flex}`).join('\n')}` : ''}
</style>`;
  const links = downloads.map((d) => `<a href="${esc(d.file)}" download type="${esc(d.mime)}"${d.variant ? ` data-v="${esc(d.variant)}"` : ''} title="${esc(d.note)}">${esc(d.label)} <i>${sz(d.bytes)}</i></a>`).join('');
  const bar = `<div class="dl"><span>download</span>${links}</div>`;
  const withStyle = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : html;
  const anchor = '<canvas id="c"></canvas>';
  return withStyle.includes(anchor) ? withStyle.replace(anchor, `${anchor}\n    ${bar}`) : withStyle;
}

/** Pull the emitted `const GROUPS = [...]` array out of a baked page. */
function readGroups(html) {
  const at = html.indexOf('const GROUPS = ');
  if (at === -1) throw new Error('emitted page has no GROUPS array — the emitter changed shape');
  const from = at + 'const GROUPS = '.length;
  const to = html.indexOf('];', from);
  if (to === -1) throw new Error('could not find the end of the GROUPS array');
  return { json: html.slice(from, to + 1), start: from, end: to + 1, groups: JSON.parse(html.slice(from, to + 1)) };
}

/**
 * Fuse several bakes of the SAME geometry into one page with a variant toggle.
 *
 * This is only sound because the variants differ in colour, not in shape: every group's
 * `pos` buffer must be byte-identical across bakes, which is asserted here rather than
 * assumed. A variant that moved a vertex would need its own page, and this refuses.
 *
 * The HOST bake is whichever one carries toon ink, because the ink buffers (inverted hull
 * + crease lines) exist only in that bake and cannot be synthesised from the other. The
 * host's `col` is then rewritten to the DEFAULT variant's colours, so the first paint is
 * already correct and no swap is needed before the first frame.
 *
 * Two seams into the emitted page, both asserted: `meshes[grp.name]` (re-exposed on
 * window so the toggle can reach the colour attribute) and `window.__mojInk.set()`, which
 * the emitter already exposes for exactly this kind of control.
 */
function fuseVariants(bakes, variants) {
  const parsed = bakes.map((html) => readGroups(html));
  const names = parsed.map((p) => p.groups.map((g) => g.name).join('\u0000'));
  if (new Set(names).size !== 1) {
    throw new Error('variants do not share their render groups — they are different worlds, publish them separately');
  }
  for (let g = 0; g < parsed[0].groups.length; g++) {
    const pos = parsed.map((p) => p.groups[g].pos);
    if (new Set(pos).size !== 1) {
      throw new Error(`variant geometry differs in group '${parsed[0].groups[g].name}' — only colour variants can be fused, publish these separately`);
    }
  }

  // host = the bake that carries ink; its extra buffers cannot be reconstructed from another.
  let hostIdx = parsed.findIndex((p) => p.groups.some((g) => g.ink));
  if (hostIdx === -1) hostIdx = 0;
  const host = parsed[hostIdx];

  // the colour set each variant swaps in, keyed by group name
  const cols = variants.map((v, i) => Object.fromEntries(parsed[i].groups.map((g) => [g.name, g.col])));
  // The host page already ships the DEFAULT variant's colours inside GROUPS. Shipping them
  // again in the toggle payload would duplicate a full colour set (1.1 MB here), so the
  // default carries no colours and the toggle snapshots the live buffers instead.
  const inkOn = variants.map((v, i) => parsed[i].groups.some((g) => g.ink));

  // first paint shows the default variant: rewrite the host's colours in place
  const hostGroups = host.groups.map((g) => ({ ...g, col: cols[0][g.name] }));
  let html = bakes[hostIdx].slice(0, host.start) + JSON.stringify(hostGroups) + bakes[hostIdx].slice(host.end);

  // seam 1: re-expose the per-group meshes so the toggle can reach their colour attribute
  const hook = 'scene.add(m); meshes[grp.name] = m;';
  if (!html.includes(hook)) throw new Error('emitted page no longer registers meshes the expected way — the variant toggle needs that seam');
  html = html.replace(hook, `${hook} (window.__mojMeshes || (window.__mojMeshes = {}))[grp.name] = m;`);

  const data = variants.map((v, i) => ({ key: v.key, label: v.label, ink: inkOn[i], cols: i === 0 ? null : cols[i] }));
  const buttons = variants.map((v) => `<button data-v="${esc(v.key)}"${v === variants[0] ? ' class="on"' : ''}>${esc(v.label)}</button>`).join('');
  const ui = `<div class="vr">${buttons}</div>`;
  const style = `<style>
  .vr{position:absolute;left:8px;top:40px;display:flex;gap:6px;z-index:6}
  .vr button{color:#9cc4ff;background:rgba(11,18,32,.6);border:1px solid #24324a;border-radius:5px;padding:4px 10px;cursor:pointer;font:13px/1.4 system-ui,sans-serif}
  .vr button.on{background:#1b2740;color:#fff}
</style>`;
  const script = `<script type="module">
// Variant toggle. The geometry is shared, so switching only swaps the colour attribute and
// flips the toon ink on or off — nothing is re-uploaded and nothing reloads.
const VARIANTS = ${JSON.stringify(data)};
const wrap = document.getElementById('wrap');
function decodeF32(s){const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new Float32Array(u.buffer);}
// The buffers the page loaded with ARE the default variant's colours; keep a copy so the
// default needs no colour payload of its own.
const ORIG = {};
for (const name in (window.__mojMeshes || {})) {
  const a = window.__mojMeshes[name].geometry.getAttribute('color');
  if (a) ORIG[name] = a.array.slice();
}
function apply(key){
  const v = VARIANTS.find((x) => x.key === key); if (!v) return;
  const meshes = window.__mojMeshes || {};
  for (const name in meshes) {
    const attr = meshes[name].geometry.getAttribute('color'); if (!attr) continue;
    const src = v.cols ? (v.cols[name] && decodeF32(v.cols[name])) : ORIG[name];
    if (!src) continue;
    attr.array.set(src); attr.needsUpdate = true;
  }
  if (window.__mojInk) window.__mojInk.set(!!v.ink);
  wrap.dataset.variant = key;
  for (const b of wrap.querySelectorAll('.vr button')) b.classList.toggle('on', b.dataset.v === key);
}
for (const b of wrap.querySelectorAll('.vr button')) b.addEventListener('click', () => apply(b.dataset.v));
// The host bake already carries the default variant's colours, so this only settles ink —
// and it runs before the first animation frame, so there is no flash of the wrong look.
apply(VARIANTS[0].key);
<\/script>`;
  html = html.replace('</head>', `${style}</head>`);
  const anchor = '<canvas id="c"></canvas>';
  if (!html.includes(anchor)) throw new Error('emitted page has no canvas anchor for the variant toggle');
  html = html.replace(anchor, `${anchor}\n    ${ui}`);
  return html.replace('</body>', `${script}</body>`);
}

/** sharp, from the control plane's node_modules — the same borrow as puppeteer-core below. */
async function loadSharp() {
  const require = createRequire(path.join(CONTROL, 'package.json'));
  return (await import(pathToFileURL(require.resolve('sharp')).href)).default;
}

/**
 * Resize the photographs into the world directory.
 *
 * PRIVACY, not an optimisation: phone photos carry an EXIF GPS fix, and these are pictures
 * taken at home. Publishing the originals would put the photographer's coordinates on a
 * public site inside every downloadable image. sharp copies no metadata unless asked, so
 * re-encoding drops GPS, camera body and timestamps; `.rotate()` bakes the EXIF orientation
 * into the pixels first, so dropping that tag cannot turn a photo sideways.
 * verifyPhotoPrivacy re-reads what was written and fails the publish if anything survived.
 */
async function writePhotos(dir, slug, sources, captions) {
  const sharp = await loadSharp();
  const outDir = path.join(dir, 'photos');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));   // no orphans from a shorter set

  const out = [];
  for (let i = 0; i < sources.length; i++) {
    const n = String(i + 1).padStart(2, '0');
    const base = sharp(sources[i]).rotate();
    const meta = await base.metadata();
    const full = await base.clone().resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const thumb = await base.clone().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    fs.writeFileSync(path.join(outDir, `${n}.jpg`), full);
    fs.writeFileSync(path.join(outDir, `${n}-t.jpg`), thumb);
    const dims = await sharp(full).metadata();
    const tdims = await sharp(thumb).metadata();
    out.push({
      file: `photos/${n}.jpg`, thumb: `photos/${n}-t.jpg`,
      path: `w/${slug}/photos/${n}.jpg`, thumbPath: `w/${slug}/photos/${n}-t.jpg`,
      bytes: full.length, thumbBytes: thumb.length,
      width: dims.width, height: dims.height,
      thumbWidth: tdims.width, thumbHeight: tdims.height,
      source: path.basename(sources[i]),
      caption: captions[i] || '',
      sourcePixels: meta.width && meta.height ? `${meta.width}\u00d7${meta.height}` : null,
    });
  }
  return out;
}

/** Re-read what was written and refuse to publish if any EXIF/GPS survived the re-encode. */
async function verifyPhotoPrivacy(dir, photos) {
  const sharp = await loadSharp();
  const leaked = [];
  for (const p of photos) {
    for (const rel of [p.file, p.thumb]) {
      const m = await sharp(path.join(dir, rel)).metadata();
      if (m.exif || m.gps || m.xmp || m.icc_description) leaked.push(`${rel} (${[m.exif && 'exif', m.gps && 'gps', m.xmp && 'xmp'].filter(Boolean).join(', ')})`);
    }
  }
  return leaked;
}

/** Build the 1200x630 og:image from a photograph instead of a WebGL screenshot. */
async function writeHeroFrom(src, dest) {
  const sharp = await loadSharp();
  await sharp(src).rotate().resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 80, mozjpeg: true }).toFile(dest);
  return fs.statSync(dest).size;
}

/**
 * Put the photographs under the viewer. The 3D page argues the object exists; these show it
 * actually made. Thumbnails carry the strip and the full frame opens in a lightbox, so the
 * page costs a few hundred KB up front rather than the whole set.
 */
function injectPhotos(html, photos, title) {
  if (!photos.length) return html;
  const style = `<style>
  .shots{width:1120px;max-width:100%;padding:26px 16px 52px;box-sizing:border-box}
  .shots h2{margin:0 0 4px;font-size:15px;font-weight:600;color:#e8ecf3}
  .shots .note{margin:0 0 16px;color:#6f86ad;font-size:12.5px;max-width:62ch}
  .strip{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
  .strip figure{margin:0}
  /* height:auto matters — with an intrinsic height attribute present, aspect-ratio is
     ignored unless the used height is auto, and the strip would render full-length. */
  .strip img{width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;display:block;border-radius:8px;border:1px solid #24324a;cursor:zoom-in;background:#0e1420}
  .strip img:hover{border-color:#39506b}
  .strip figcaption{margin-top:6px;font-size:11.5px;color:#6f86ad;line-height:1.35}
  .lb{position:fixed;inset:0;background:rgba(5,8,14,.94);display:none;align-items:center;justify-content:center;z-index:50;cursor:zoom-out;padding:24px}
  .lb.on{display:flex}
  .lb img{max-width:100%;max-height:88vh;object-fit:contain;border-radius:8px}
  .lb .cap{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:#9fb3d0;font-size:12.5px;padding:0 24px}
</style>`;
  const figs = photos.map((p, i) => `<figure><img loading="lazy" src="${esc(p.thumb)}" data-full="${esc(p.file)}" data-cap="${esc(p.caption)}" alt="${esc(p.caption || title)}" width="${p.thumbWidth}" height="${p.thumbHeight}"><figcaption>${esc(p.caption)}</figcaption></figure>`).join('');
  const section = `<section class="shots">
    <h2>Printed</h2>
    <p class="note">Photographs of this recipe actually printed \u2014 the STL below is the file that made them.</p>
    <div class="strip">${figs}</div>
  </section>
  <div class="lb" id="lb"><img alt=""><div class="cap"></div></div>`;
  const script = `<script>
(function(){
  const lb=document.getElementById('lb'), img=lb.querySelector('img'), cap=lb.querySelector('.cap');
  for (const t of document.querySelectorAll('.strip img')) t.addEventListener('click',()=>{
    img.src=t.dataset.full; img.alt=t.alt; cap.textContent=t.dataset.cap||''; lb.classList.add('on');
  });
  const close=()=>{ lb.classList.remove('on'); img.removeAttribute('src'); };
  lb.addEventListener('click',close);
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') close(); });
})();
<\/script>`;
  const withStyle = html.replace('</head>', `${style}</head>`);
  return withStyle.replace('</body>', `${section}\n${script}</body>`);
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
    await page.addStyleTag({ content: `.hud,.hint,.moj-readout,.dl,.vr,.shots,.lb{display:none!important}
      body{display:block!important;margin:0!important}
      #wrap{width:${CARD_W}px!important;height:${CARD_H}px!important;max-width:none!important;aspect-ratio:auto!important}` });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(dir, 'card.jpg'), type: 'jpeg', quality: 78 });
  } finally { await browser.close(); server.close(); }
  return fs.statSync(path.join(dir, 'card.jpg')).size;
}

// ── bake ──────────────────────────────────────────────────────────────────────
/** A short button label per variant: --labels wins, else the part of the title that differs. */
function deriveLabels(titles) {
  if (LABELS.length) return LABELS;
  let i = 0;
  while (i < titles[0].length && titles.every((t) => t[i] === titles[0][i])) i++;
  const tails = titles.map((t) => t.slice(i).replace(/^[\s\u2014\u2013-]+/, '').trim());
  return tails.map((t, n) => {
    if (!t) return `V${n + 1}`;
    const short = t.length > 16 ? t.slice(0, 16).trim() : t;
    return short.charAt(0).toUpperCase() + short.slice(1);
  });
}

/** Resolve one ref into everything the bake needs, or null with a reason printed. */
async function loadVariant(ref) {
  const sketch = SketchRepository.getByRef(ref);
  if (!sketch) { console.error(`\u2717 ${ref} — no such sketch`); return null; }
  let resolved;
  try { resolved = await resolveWorldScene(sketch, {}); }
  catch (e) { console.error(`\u2717 ${ref} — resolve failed: ${e.message}`); return null; }
  if (!resolved?.payload) { console.error(`\u2717 ${ref} — not world-eligible (kind has no traversable world)`); return null; }
  return { ref, sketch, manifest: sketch.manifest, payload: resolved.payload, kind: resolved.kind, title: sketch.title || ref };
}

// One "world" is a list of variants: a plain publish is a list of one, --consolidate makes
// every positional ref a variant of the same exhibit.
const jobs = CONSOLIDATE ? [refs] : refs.map((r) => [r]);

for (const job of jobs) {
  const t0 = Date.now();
  const loaded = [];
  for (const ref of job) { const v = await loadVariant(ref); if (v) loaded.push(v); }
  if (!loaded.length) continue;
  if (CONSOLIDATE && loaded.length !== job.length) {
    console.error('\u2717 consolidation needs every variant to resolve — nothing written');
    continue;
  }

  const labels = loaded.length > 1 ? deriveLabels(loaded.map((v) => v.title)) : [null];
  const variants = loaded.map((v, i) => ({ ...v, label: labels[i], key: labels[i] ? slugify(labels[i]) : null }));
  const primary = variants[0];

  const slug = (jobs.length === 1 && typeof opts.slug === 'string' ? opts.slug : null) || slugify(primary.ref);
  const dir = path.join(REPO, 'w', slug);
  const dirExisted = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });

  const title = (typeof opts.title === 'string' && opts.title) || primary.title;
  const description = variants.length > 1
    ? `${describe(primary.sketch, primary.kind)} ${variants.length} versions — ${variants.map((v) => v.label).join(' and ')} — one model, switchable in place.`.slice(0, 200)
    : describe(primary.sketch, primary.kind);
  const url = `${BASE}/w/${slug}/`;

  // A Blender Cycles hero (tools/render-hero.mjs) outranks the WebGL screenshot: if one is
  // already committed for this slug, use it as og:image and skip the capture entirely.
  // --recard forces a fresh WebGL card even when a hero exists.
  // --hero-from makes that hero out of a PHOTOGRAPH: for an object that exists in the world,
  // a picture of the real thing is a better share card than any render of it.
  const heroPath = path.join(dir, 'hero.jpg');
  if (typeof opts['hero-from'] === 'string') {
    try { await writeHeroFrom(opts['hero-from'], heroPath); }
    catch (e) { console.error(`  \u21b3 hero skipped: ${e.message}`); }
  }
  const hasHero = fs.existsSync(heroPath) && (!opts.recard || typeof opts['hero-from'] === 'string');
  const heroBytes = hasHero ? fs.statSync(heroPath).size : 0;

  // Models first: the download bar has to know each file's real size, and the bar is part
  // of every bake below (including the one the card is shot from, where CSS hides it).
  // A world that already offers downloads keeps them on a re-publish without the flag —
  // re-exported, never carried over, so the file and the page never drift apart.
  const prior = catalog.worlds.find((w) => w.slug === slug);
  const formats = WANT_DOWNLOADS.length
    ? WANT_DOWNLOADS
    : [...new Set((prior?.downloads || []).map((d) => d.format))].filter((f) => FORMATS[f]);
  const downloads = formats.length ? writeDownloads(dir, slug, variants, formats) : [];

  // Photographs, re-encoded (which is what strips the GPS) before anything references them.
  let photos = [];
  if (PHOTOS.length) {
    photos = await writePhotos(dir, slug, PHOTOS, CAPTIONS);
    const leaked = await verifyPhotoPrivacy(dir, photos);
    if (leaked.length) {
      console.error(`\u2717 ${slug} \u2014 metadata survived re-encoding, refusing to publish:\n    ${leaked.join('\n    ')}`);
      continue;
    }
  }

  // Bake once WITHOUT the card image, capture from that page, then re-inject with it.
  // The screenshot is of the world itself, so it cannot reference its own url.
  const emit = (v) => emitThreeWorld({ ...v.payload, cdn: true });
  const bake = (image) => {
    const base = variants.length > 1
      ? fuseVariants(variants.map(emit), variants)
      : emit(primary);
    return injectPhotos(
      injectDownloads(injectCard(base, { title, description, url, image }), downloads, variants),
      photos, title,
    );
  };
  let html;
  try { html = bake(hasHero ? `${url}hero.jpg` : null); }
  catch (e) {
    console.error(`\u2717 ${slug} — ${e.message}`);
    // A refused bake should leave no trace: drop the directory this run created.
    if (!dirExisted && fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    continue;
  }
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
  const photoBytes = photos.reduce((a, p) => a + p.bytes + p.thumbBytes, 0);
  const bytes = Buffer.byteLength(html) + cardBytes + heroBytes + downloadBytes + photoBytes;
  const gzip = zlib.gzipSync(Buffer.from(html), { level: 9 }).length;   // what Pages actually serves
  const entry = {
    slug, ref: primary.ref, title, description,
    kind: primary.kind,
    url,
    card: cardBytes ? `w/${slug}/card.jpg` : null,
    hero: hasHero ? `w/${slug}/hero.jpg` : null,
    ...(variants.length > 1
      ? { variants: variants.map((v) => ({ key: v.key, label: v.label, ref: v.ref, title: v.title })) }
      : {}),
    ...(downloads.length ? { downloads } : {}),
    ...(photos.length ? { photos } : {}),
    bytes, gzip,
    recipeBytes: variants.reduce((a, v) => a + Buffer.byteLength(JSON.stringify(v.manifest)), 0),
    bakedAt: new Date().toISOString().slice(0, 10),
  };
  const i = catalog.worlds.findIndex((w) => w.slug === slug);
  if (i === -1) catalog.worlds.push(entry); else catalog.worlds[i] = entry;

  console.log(`\u2713 w/${slug}/  ${mb(bytes)} on disk \u00b7 ${mb(gzip)} over the wire \u00b7 recipe ${entry.recipeBytes} B \u00b7 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (variants.length > 1) console.log(`  \u21b3 ${variants.length} variants in one page: ${variants.map((v) => `${v.label} (${v.ref})`).join(' \u00b7 ')}`);
  if (hasHero) console.log(`  \u21b3 hero.jpg ${Math.round(heroBytes / 1024)} KB (${typeof opts['hero-from'] === 'string' ? 'photo' : 'cycles'}) \u00b7 og:image ${url}hero.jpg`);
  else if (cardBytes) console.log(`  \u21b3 card.jpg ${Math.round(cardBytes / 1024)} KB \u00b7 og:image ${url}card.jpg`);
  for (const d of downloads) console.log(`  \u21b3 ${d.file.padEnd(16)} ${sz(d.bytes).padStart(7)} \u00b7 ${d.note}`);
  if (photos.length) console.log(`  \u21b3 ${photos.length} photo${photos.length === 1 ? '' : 's'} ${sz(photoBytes).padStart(9)} \u00b7 re-encoded from ${photos[0].sourcePixels || 'source'} \u00b7 EXIF/GPS stripped and verified`);
}

catalog.worlds.sort((a, b) => a.slug.localeCompare(b.slug));
catalog.updatedAt = new Date().toISOString();
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');

const total = catalog.worlds.reduce((a, w) => a + w.bytes, 0);
console.log(`\ncatalog: ${catalog.worlds.length} worlds · ${mb(total)} of the 1024 MB Pages ceiling (${(100 * total / 1073741824).toFixed(1)}%)`);
