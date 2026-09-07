# Logo variants — the 2026-09-07 exploration

Ten candidate symbols for the Winnow mark, drawn to replace the vermillion
winnowing arc that had been in production since the start.

**`08-sieve.svg` — "Le tri" — was chosen and is live.** The other nine stay here
as the record of what was considered and why it was passed over; they are not
wired to anything.

The adopted file carries the **production** geometry, which differs from what the
chooser showed: the mass is a filled disc at half opacity instead of a hollow
ring, and the sieve is a solid hairline instead of a dash. A 0.95-wide ring
closes into a blob at 16 px and a dash pattern vanishes there — exactly the
failure that retired the feather, so shipping it unchanged would have traded one
16 px problem for another. Size and opacity now carry "many small in, few big
out" in place of the hollow/filled contrast.

The two **inverted** copies — the `.brand-mark` pill and `icon-maskable.svg` —
carry higher opacities (mass 0.68, sieve 0.45) than the paper ones (0.5, 0.32).
Fading paper toward a saturated vermillion loses far more perceived contrast
than fading vermillion toward paper, so the favicon's values go murky in the
pill. This only showed up by rendering the real `Brand` markup against the built
CSS; the vector at 200 px looked fine either way.

Visual chooser (every mark in its six real contexts, both themes, plus a true
16 px raster of each):
<https://claude.ai/code/artifact/5f8087f7-8876-427e-8f37-86a986ae3ca5>

## Constraints every variant respects

- **One accent.** Vermillion (`--color-accent`) and nothing else — the "Paper"
  system spends its only colour here, and the chrome stays quiet so the photos
  carry the rest (`src/app/globals.css` header, `docs/memory/frontend.md`).
- **24×24 viewBox, `currentColor`, round caps.** Same geometry as the `Brand`
  component, so a variant is copied in rather than re-traced. The icon files use
  heavier strokes than `Brand` (2.1/1.7 vs 1.6/1.3) to hold up against a filled
  tile — that ratio has to be re-applied whichever variant wins.
- **Legibility at 16 px comes before meaning.** The incumbent fails exactly
  there: its three parallel arcs merge into one curve. Any replacement that
  merges the same way trades one problem for another.

## The ten

Ordered by how much drawing they contain, not by preference.

| # | File | Idea | What it gives up |
| --- | --- | --- | --- |
| 01 | `01-keeper.svg` | Four grains on a diagonal, one solid — the selection rate, drawn | A diagram, not an image: says nothing about the fan or the photo |
| 02 | `02-fall.svg` | The tipped fan and the grain falling back in — two strokes | So universal it is generic: a hollow and a dot is also a gauge |
| 03 | `03-fan.svg` | The fan head-on, grain in the throat | A lone V also reads "validate" or "expand" |
| 04 | `04-grain.svg` | One almond = wheat grain, lens, eye | The prettiest and the mutest; without the word it is a leaf |
| 05 | `05-monogram.svg` | Broad-nib W, heavy down-strokes, hairline up-strokes | A monogram tells you nothing about the product; contrast flattens under 20 px |
| 06 | `06-toss.svg` | The fan plus the toss: one grain landed, three airborne | The smallest grain disappears below 24 px |
| 07 | `07-feather.svg` | The incumbent redrawn: filled vane instead of parallel arcs | Still a feather — a writing metaphor, not a sorting one |
| 08 | `08-sieve.svg` | **Chosen.** Sieve in the middle, the mass left, the survivors right | At 16 px the mass is a texture, not six countable grains — accepted |
| 09 | `09-wind.svg` | The whole story — fan, grain back, chaff blowing off | Seven objects in 24 units; splash-only |
| 10 | `10-sheet.svg` | Nine frames, one kept, one struck | Describes the screen rather than the idea; the grid fills in below 32 px |

`02-fall.svg` carries a note worth repeating: a **symmetric** bowl under a
centred dot reads as a smiling face. The asymmetry in that path is load-bearing,
not styling — the first draft was symmetric and had to be thrown away.

## Adopting one — the five copies

Done for `08` on 2026-09-07; the list stands for whoever changes the mark next.
The symbol lives in five independent places, and missing one leaves the old mark
in production somewhere.

1. `public/icons/icon.svg`, `icon-maskable.svg`, `icon-apple.svg` — three
   sources with different insets, and the maskable one is **inverted** (paper
   glyph on a full-bleed vermillion square).
2. `npx tsx scripts/gen-icons.ts` — rasterises the seven PNGs. Without it the
   favicons keep the old drawing however good the SVG is.
3. `src/app/ui.tsx` → `Brand` — thinner strokes, `currentColor` mandatory (the
   pill inverts the mark to `--color-accent-fg`).
4. `public/offline.html` lines 83-85 — the fifth copy, with hardcoded hex. The
   one that gets forgotten.
5. `public/sw.js` → `VERSION` — the icons are precached; without a bump the
   service worker keeps serving the old ones.

Nothing else needs touching as long as the palette does not move: `manifest.ts`,
`layout.tsx`'s `viewport.themeColor` and `offline.html` only carry the paper and
night backgrounds, not the mark.
