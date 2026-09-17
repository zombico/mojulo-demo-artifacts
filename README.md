# mojulo-demo-artifacts

Shareable 3D worlds on GitHub Pages. Each world is baked from a mojulo recipe into a
self-contained page you can link to:

```
https://zombico.github.io/mojulo-demo-artifacts/w/<slug>/
```

## Link previews

Every page carries baked Open Graph + Twitter Card tags, so a pasted URL renders as a
card in Slack, Discord, iMessage, X and LinkedIn instead of a bare link.

These are **baked at publish time, not generated dynamically** — Pages is static and link
crawlers do not execute JavaScript, so there is no request-time or client-side option. The
consequence: **re-publish a world after changing its title, and re-share to refresh** (most
platforms cache a card for hours to days; Slack and X both offer a manual re-scrape).

- `card.jpg` — a 1200×630 screenshot of the world itself, interactive chrome hidden, ~40–70 KB
- `og:image` and `og:url` are absolute (crawlers reject relative), which is why `--base` exists
- tags sit in the first ~3 KB of the file, so crawlers that fetch only the first chunk still see them

On X specifically, a static card is the ceiling: autoplay is native-media only, and Player
Cards do not autoplay. A linked page cannot animate in the timeline no matter what it
carries — to put motion on X you upload a file, which is a deliberately local-only path here.

```bash
node tools/check-cards.mjs   # required tags · absolute urls · card file present · head budget
```

CI runs that check and refuses to deploy if any page would share as a plain URL.

## Hero renders (Blender Cycles)

A page's card can be a path-traced still instead of a WebGL screenshot. Unlike video, this
asset **is** committed — it becomes the `og:image` and the gallery thumbnail.

```bash
node tools/render-hero.mjs <slug|ref> [--samples 192] [--res 1200x630] \
     [--exposure 0] [--sky 1.2] [--light sun|studio] [--open] [--pad 1.12]
node tools/publish.mjs <ref>    # bakes hero.jpg in as og:image (and skips the WebGL capture)
```

Blender is **optional and never a dependency**: without it the tool exits with a message and
pages keep using `card.jpg`. A hero upgrades a page, it is never required for one.

The camera comes from the world's own framing (the same base shot the cards and turntables
use), converted through the *vertical* FOV so the shot is preserved at the render aspect —
handing Blender the authored horizontal FOV at a wider aspect crops the subject instead.

Cycles regenerates a **flat-albedo** source from the recipe so it computes all the light.
Two consequences, both learned the hard way:

- **Point it at the unlit ref.** A `_lit` sketch already carries baked GI in its vertex
  colours; re-lighting flat albedo throws away the thing that makes it distinct. The
  `_lit` worlds here deliberately keep their WebGL card, which is the honest picture of
  what the page actually renders.
- **Lighting is per-subject.** The default sun+sky suits dark objects; a light one blows
  out on a white backdrop — the silver MZ-NE410 needs `--exposure 0 --sky 1.2`. `--light
  studio` is far too hot for flat-panel objects. Check the render before committing it.

## Downloads — worlds you can take away

A page is a viewer. `--downloads` also makes it a **handoff**: the model is written beside
the page and a download bar appears on it, so the world can be opened in other software
instead of only orbited in the browser.

```bash
node tools/publish.mjs <ref> --downloads glb,stl
```

| format | what it is | what it drops |
|---|---|---|
| `glb` | the faithful depiction — vertex colours, named group nodes | nothing; opens in Blender, three.js, Windows 3D Viewer |
| `stl` | the printing handoff — binary triangle soup for slicers | colour and grouping, deliberately |

Both come off the **same resolved payload the page renders** — one bake, one geometry, so
the file you download is the thing on screen and cannot drift from it. They are written
through mojulo's own export seam (`facesToGlb` / `facesToStl`), the same functions the
`export_model` tool calls, so a published download is byte-identical to an in-app export.

STL carries no units and slicers assume millimetres, so the recipe's declared units set the
scale — the spider-tank declares `cm`, becomes ×10, and prints at 105 × 63 × 52 mm. The
button's tooltip states the printed size, because a silently mis-scaled STL is the failure
people only discover at the printer.

Two things to know:

- **Downloads are committed assets and count against the 1 GB ceiling.** A GLB + STL pair
  is ~2.5 MB and roughly doubles a small world's footprint. `bytes` in `catalog.json`
  includes them; `gzip` does not, because that figure is what a *visit* costs and a
  download is a second, opt-in request.
- **Re-publishing keeps them.** Once a world offers downloads, a later `publish.mjs` with
  no `--downloads` flag re-exports the same formats rather than silently dropping the bar.
  They are re-exported, never carried over, so page and file stay in lockstep.

`check-cards.mjs` gates them the way it gates cards: every advertised download must exist,
be non-empty, match the size on the button, and be linked from the page. CI refuses to
deploy a page whose download bar points at a 404.

## Publishing

Worlds are baked **locally** — resolving one needs the operator's sketches DB and the graph
library, neither of which ever leaves the host. CI only uploads what was committed.

```bash
node tools/publish.mjs <sketch-ref> [<sketch-ref>...] [--slug name] [--base url] [--no-card] [--downloads glb,stl]
node tools/gallery.mjs     # regenerate index.html from catalog.json
node tools/budget.mjs      # audit against the Pages ceilings
git add -A && git commit -m "publish: <slug>" && git push
```

`--control <path>` points at the mojulo control plane (default `../mojulo/control`).
`--base <url>` sets the public site root used for absolute card URLs; it sticks in
`catalog.json`, so later publishes inherit it. `--no-card` skips the screenshot (fast, but
the page then previews as a title-and-text card with no image). `--downloads glb,stl` writes
the model beside the page and puts a download bar on it (see above).

## What a world costs

Measured, not estimated, on this machine:

| world | recipe | page on disk | served (gzip) | bake |
|---|---|---|---|---|
| floorplan (`sk_floorauto1`) | 141 B | 2.62 MB | **0.29 MB** | 0.5 s |
| walker (`sk_diaz_unit_v1`) | 2.2 KB | 2.31 MB | **0.75 MB** | 1.1 s |
| walker (`sk_gframe_mk2`) | 2.2 KB | 2.79 MB | **0.88 MB** | 2.5 s |
| spider-tank (`sk_49p4u0f407`) | 25 KB | 2.32 MB | **0.31 MB** | 22 s |
| — the same, with GLB + STL | | 4.81 MB | **0.31 MB** | |
| arena (`snow-valley-arena`) | 3.6 MB | 24.90 MB | **8.05 MB** | 75 s |

The recipe is tiny; the *baked page* is not. 74–88% of every page is base64-encoded geometry,
which alone costs 0.5 MB (walker) to 5.5 MB (arena) in pure base64 overhead.

three.js is **not** in that budget — `cdn: true` loads it from jsdelivr (86 KB gzip),
cached once across every world on the site. Inlining it would add ~365 KB to every page.

## The ceilings

| limit | value | kind |
|---|---|---|
| published site | 1 GB | hard |
| source repo | 1 GB | recommended |
| bandwidth | 100 GB/month | soft |
| deploy time | 10 min | hard |

**GitHub Pages serves gzip, never brotli** — verified by request, not assumed. Brotli would
cut a walker from 0.88 MB to 0.55 MB, but Pages will not serve it, and the 1 GB ceiling is
measured against the *uncompressed* files you commit.

## How many worlds fit

The 1 GB site ceiling is the binding constraint, and it counts raw bytes on disk:

- **walkers / floorplans** (~2.6 MB) → **~390 worlds**
- **baked arenas** (~25 MB) → **~40 worlds**
- a realistic mix (90% walkers, 10% arenas) → **~250 worlds**

Bandwidth is not the limit. At 0.6 MB served per view, 100 GB/month is **~160,000 views** —
you will hit the disk ceiling long before the traffic ceiling.

## Sustainability

Honest answer: **sustainable for a few hundred demo worlds, not for a growing archive.**

Two things bound it. Baked pages are ~1000× their recipe, and **git history is forever** —
re-publishing one walker ten times costs ten copies on disk, not one. Budget churn, not just
count, and squash or re-init history if the pack grows.

Three ways to buy headroom, cheapest first:

1. **Don't publish arenas with baked `faces`.** One arena costs ten walkers. Biggest single win.
2. **Split the payload.** Ship a small HTML shell plus the geometry as a `.gz` blob the page
   inflates with the browser's built-in `DecompressionStream('gzip')`. Storage drops ~3.1×
   (2.8 MB → 0.88 MB), so ~390 worlds becomes **~1200**. Transfer is unchanged (Pages already
   gzips), so this buys *capacity*, not speed. Add a brotli-wasm decoder and storage drops ~5×
   *and* transfer improves to 0.55 MB — better than Pages can do natively.
3. **Ship recipes, not renders.** Publish the 2 KB recipe plus one shared renderer bundle and
   regenerate geometry in the browser. Storage per world collapses to ~2 KB — effectively
   unlimited worlds. This is the architecturally right answer and matches how mojulo already
   thinks, but it is **real work**: 61 of the 599 files in `lib/graph/` import node builtins
   (`world-kinds.js` reads recipe files off disk at runtime), so the assembly path needs a
   browser port. Weeks, not a weekend.

Option 2 is the pragmatic next step. Option 3 is the one that makes the question go away.

## Layout

```
index.html         gallery (generated by tools/gallery.mjs)
catalog.json       one entry per world — slug, ref, sizes, thumbnail
w/<slug>/          index.html + card.jpg (1200×630 social card)
                   + model.glb / model.stl when published --downloads
tools/             publish · gallery · budget · check-cards
.github/workflows  deploy, with a hard 1 GB gate before upload
```
