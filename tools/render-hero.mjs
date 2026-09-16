#!/usr/bin/env node
/**
 * render-hero.mjs — render a world's hero still with Blender Cycles and COMMIT it.
 *
 *   node tools/render-hero.mjs <slug|sketch-ref> [--samples 128] [--res 1200x630]
 *        [--light sun|studio] [--sun elev,az] [--exposure 1.2] [--open] [--control path]
 *
 * Unlike the video worker, the output IS committed: it becomes the page's og:image and
 * the gallery thumbnail, replacing the WebGL screenshot card. A path-traced still with
 * real GI is what a link preview should look like, and one JPEG per world is cheap
 * against the 1 GB ceiling.
 *
 * Blender is OPTIONAL and never a dependency (CLAUDE.md): without it this tool fails
 * with a clear message and the site keeps building from the WebGL card.jpg. A hero is
 * an upgrade to a page, never a requirement for one.
 *
 * Framing: the camera is derived from the world's OWN framing (deriveBaseShot — the same
 * base shot the cards and the turntable use), so the hero matches the composition people
 * already see instead of Blender's default angle.
 *
 * Source: blender-bake.mjs regenerates a flat-albedo GLB from the recipe (`unshaded:true`)
 * so Cycles computes ALL the light. Point it at the UNLIT ref — a `_lit` sketch already
 * carries baked GI in its vertex colours and would be lit twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');

const VALUE_FLAGS = new Set(['samples', 'res', 'light', 'sun', 'exposure', 'control', 'out', 'view', 'sky', 'roughness', 'fov', 'pad']);
const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const n = a.slice(2); if (VALUE_FLAGS.has(n)) opts[n] = argv[++i]; else opts[n] = true; }
  else positional.push(a);
}
const target = positional[0];
if (!target) {
  console.error('usage: node tools/render-hero.mjs <slug|sketch-ref> [--samples 128] [--res 1200x630] [--light sun|studio] [--open]');
  process.exit(1);
}

const CONTROL = path.resolve(opts.control || process.env.MOJULO_CONTROL || path.join(REPO, '..', 'mojulo', 'control'));
if (!fs.existsSync(path.join(CONTROL, 'package.json'))) {
  console.error(`✗ mojulo control plane not found at ${CONTROL}`); process.exit(1);
}
const BLENDER = process.env.MOJULO_BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!fs.existsSync(BLENDER)) {
  console.error(`✗ Blender not found at ${BLENDER}\n  install it or set MOJULO_BLENDER. The site still builds without a hero —\n  pages fall back to the WebGL card.jpg.`);
  process.exit(1);
}

const catalogPath = path.join(REPO, 'catalog.json');
const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { worlds: [] };
const published = catalog.worlds.find((w) => w.slug === target || w.ref === target);
const ref = published?.ref || target;
const slug = published?.slug || target;
if (!published) console.error(`⚠ ${slug} is not in catalog.json — rendering anyway, but publish it to wire the hero in.`);

const res = String(opts.res || '1200x630');
const samples = String(opts.samples || 128);

process.chdir(CONTROL);
process.env.MOJULO_DATA_DIR ||= path.join(CONTROL, 'data');
process.env.MOJULO_OUTCOMES_DIR ||= path.join(CONTROL, 'data', 'outcomes');
register('./mcp-stdio-loader.mjs', pathToFileURL(path.join(CONTROL, 'scripts/')));

const { SketchRepository } = await import('@/lib/db/repositories/sketches');
const { resolveWorldScene } = await import('@/lib/graph/worlds/world-scene');
const { deriveBaseShot } = await import('@/lib/motion/world-motion');
const { resolveFfmpeg, runFfmpeg } = await import('@/lib/motion/ffmpeg');

const sketch = SketchRepository.getByRef(ref);
if (!sketch) { console.error(`✗ ${ref} — no such sketch`); process.exit(1); }

// Match the composition the cards and turntable already use.
const { payload } = await resolveWorldScene(sketch, { view: opts.view });
if (!payload) { console.error(`✗ ${ref} — not world-eligible`); process.exit(1); }
const shot = deriveBaseShot(payload);
const n3 = (v) => v.map((x) => Number(x).toFixed(4)).join(',');

// The authored horizontalFov is relative to the world's NATIVE aspect. Blender's --fov is
// also horizontal, so handing it over unchanged at a wider render aspect keeps the
// horizontal extent and crops vertically — the subject loses its head and feet. Convert
// through the VERTICAL fov (tan(v/2) = tan(h/2)/aspect, scene-three's own convention) so
// the render preserves the framing the cards and turntable show.
const [renderW, renderH] = res.split('x').map(Number);
const vb = payload.viewBox || { width: 1120, height: 780 };
const nativeAspect = (vb.width || 1120) / (vb.height || 780);
const renderAspect = renderW / renderH;
const DEG = Math.PI / 180;
const vfov = 2 * Math.atan(Math.tan((shot.horizontalFov || 50) * DEG / 2) / nativeAspect);
// --pad widens the shot for breathing room around a hero subject (1.0 = exact match).
const pad = Number(opts.pad || 1.12);
const hfov = opts.fov
  ? Number(opts.fov)
  : 2 * Math.atan(Math.tan(vfov / 2) * renderAspect * pad) / DEG;

const tmpPng = path.join(CONTROL, 'data', 'outcomes', `hero-${slug}.png`);
// `--opt=value` form throughout: a camera coordinate can be negative, and node's
// parseArgs reads a leading '-' as the next OPTION rather than this option's value.
const args = [
  'scripts/blender-bake.mjs', `--ref=${ref}`, '--render', '--no-bind',
  `--res=${res}`, `--samples=${samples}`,
  `--camera=${n3(shot.cameraPosition)}`, `--look=${n3(shot.lookAt)}`, `--fov=${hfov.toFixed(3)}`,
  `--out=${tmpPng}`,
  ...(opts.light ? [`--light=${opts.light}`] : []),
  ...(opts.sun ? [`--sun=${opts.sun}`] : []),
  ...(opts.exposure ? [`--exposure=${opts.exposure}`] : []),
  ...(opts.sky ? [`--sky=${opts.sky}`] : []),
  ...(opts.roughness ? [`--roughness=${opts.roughness}`] : []),
  ...(opts.open ? ['--open'] : []),
];

console.log(`${sketch.title || ref}`);
console.log(`  cycles · ${res} · ${samples} samples · cam ${n3(shot.cameraPosition)} → ${n3(shot.lookAt)}`);
console.log(`  fov ${shot.horizontalFov}° h @ ${nativeAspect.toFixed(2)} native → ${hfov.toFixed(1)}° h @ ${renderAspect.toFixed(2)} render (pad ${pad})`);

const t0 = Date.now();
const code = await new Promise((r) => {
  const p = spawn(process.execPath, args, { cwd: CONTROL, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  p.stdout.on('data', (d) => { tail += d; });
  p.stderr.on('data', (d) => { tail += d; });
  p.on('close', (c) => { if (c !== 0) console.error(String(tail).split('\n').slice(-6).join('\n')); r(c); });
});
if (code !== 0 || !fs.existsSync(tmpPng)) { console.error(`✗ Cycles render failed (exit ${code})`); process.exit(1); }

// PNG → JPEG for the card: og:image wants a small file, and a 1200x630 render is ~1 MB as PNG.
const dir = path.join(REPO, 'w', slug);
fs.mkdirSync(dir, { recursive: true });
const heroPath = path.join(dir, 'hero.jpg');
const ff = await resolveFfmpeg();
await runFfmpeg(ff, ['-y', '-i', tmpPng, '-q:v', '3', heroPath]);
fs.rmSync(tmpPng, { force: true });

const bytes = fs.statSync(heroPath).size;
if (published) {
  published.hero = `w/${slug}/hero.jpg`;
  published.heroBytes = bytes;
  catalog.updatedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
}

console.log(`\n✓ w/${slug}/hero.jpg  ${Math.round(bytes / 1024)} KB · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(published
  ? `  committed — re-run tools/publish.mjs ${ref} to bake it in as og:image, then tools/gallery.mjs`
  : `  publish the world first to wire it in`);
