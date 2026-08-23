# Frontend (`src/app/**`, styling, viewer, PWA)

Read before touching a page or component under `src/app/`, the styling, the viewer/grid interactions, or the PWA.

Seeded 2026-08-20 from `src/app/globals.css`, `next.config.mjs`, `public/sw.js`, `src/app/**` component comments and `docs/ARCHITECTURE-REVIEW.md` §3.5.

## Styling: a "Paper" design system in CSS, not utilities in JSX (2026-08-20)

**Decision**: `src/app/globals.css` (~5900 lines) defines the whole visual language — an `@theme` token block (warm paper surfaces, ink text, one vermillion accent, verdict colours, radii) followed by ~630 semantic component classes built with `@apply` inside `@layer components`. Components carry class names like `.sift-recent-card`, not long utility strings. `cn()` (`src/lib/cn.ts`, a thin `clsx`) composes them conditionally.

**Why**: the UI chrome is deliberately quiet so the photos carry the colour, and the tokens are what keep that consistent across dozens of pages. The full-screen viewer is the one intentionally dark surface (`--color-frame`) — photos read best on black.

**How to apply**: reach for an existing token and an existing component class before inventing either; add a new class to the matching `@layer components` block rather than piling utilities into the JSX. Never hardcode a hex colour that a token already names.

## Every DB-backed route opts out of static rendering (2026-08-20)

**Decision**: 62 route files carry `export const dynamic = "force-dynamic"` with a one-line comment saying why ("DB-backed route: never pre-rendered/cached at build time").

**Why**: the App Router will happily pre-render a route at build time and serve stale numbers forever. Everything here reads Postgres, Redis or the filesystem.

**How to apply**: a new route that touches the database, the queue or the disk gets the same export and the same comment. This is the single most repeated convention in `src/app/api/`.

## TypeScript 7 needs an explicit Next flag (2026-08-20)

**Decision**: `next.config.mjs` sets `experimental.useTypeScriptCli: true`, and keeps `sharp`, `exiftool-vendored` and `pg` in `serverExternalPackages`.

**Why**: TypeScript 7 is the native Go compiler — it ships a CLI but no longer the JS compiler API Next drives by default, so without the flag the build aborts with *"TypeScript 7.0.2 does not provide the compiler API required by Next.js"*. The flag makes Next shell out to the project-local `tsc`, the same binary `npm run typecheck` uses. The three external packages ship native code that must not be bundled server-side.

**How to apply**: if a build suddenly fails on the compiler API, check this flag before suspecting your change. Adding another native/binary dependency means adding it to `serverExternalPackages`.

## The big lists are virtualized; the first page is deliberately small (2026-08-20)

**Decision**: `react-window` backs the gallery grid (`gallery/VirtualGrid.tsx`), the sift deck's recent strip (`sift/SwipeDeck.tsx`) and the pipeline asset list (`settings/pipeline/PipelineAssetList.tsx`). Feed page sizes are tuned with a deliberately small first page.

**Why**: the grid must paint before the rest of the page is fetched — perceived speed over fewer round-trips. react-window needs a definite height, which is why the wrappers set it inline from the viewport and use `min-h-0` flex children (commented in `globals.css`).

**How to apply**: a new long list gets virtualized, and its container needs an explicit height or it collapses. A `ResizeObserver` feeding react-window is the existing pattern for width-aware rows.

## The service worker caches almost nothing, on purpose (2026-08-20)

**Decision**: `public/sw.js` precaches only the offline page, icons and the manifest, serves the Next build shell stale-while-revalidate, and **never** caches `/api` responses or media bytes (thumb/proxy/download). It is registered in production only (`ServiceWorkerRegister.tsx`).

**Why**: the payloads are large and volatile — a cached thumbnail or JSON stat would be wrong within minutes and would waste a phone's storage on RAW-derived bytes.

**How to apply**: do not add `/api` or media to a cache. Bump `VERSION` in `sw.js` when the shell caching changes. Installability and the worker need a secure context, so the install prompt only appears over HTTPS (or `localhost`) — testing it over plain LAN http will look broken when it is not. Icons are re-rasterised from the SVG with `npx tsx scripts/gen-icons.ts` after editing `public/icons/icon.svg`.

## Touch is a first-class input and it is fiddly (2026-08-20)

**Observation**: the viewer and the sift deck hand-roll pointer/touch handling — double-tap returning to the last zoom, pointer events stopped from starting a pan/swipe on interactive overlays, a drag past `FLICK_PX` treated as a deliberate flick, and iOS's synthesized click after a touch explicitly prevented from opening the viewer.

**Why**: this is a phone-first culling tool; each of those lines is a bug someone hit on a real device.

**How to apply**: when adding an overlay or control inside the viewer/deck, stop its pointer events from reaching the gesture layer, and test on a touch device — the desktop mouse path will not reproduce the failure.

## The Incoming/Gallery toggle is a repeated pattern, not a shared component (2026-08-22)

**Decision**: `/gear` (`GearPanel.tsx`), `/people` (`PeoplePanel.tsx`) and `/search` (`SearchPage.tsx` + `api/search`) each carry their own `Source`/`GearSource` type, `SOURCES` label array, `winnow.<page>.source` localStorage key and `view-toggle`/`view-btn` markup for the same Incoming/Gallery split. `/people`'s API (`api/people`, `api/people/[id]`) now returns `incoming_face_count`/`incoming_asset_count`/`gallery_face_count`/`gallery_asset_count` per person, split with the same `rt.kind = 'finals'` vs. not test `lib/gear.ts` uses; `/search` accepts `?source=incoming|gallery` and only joins `sessions`/`roots` when a source is actually asked for, so the unfiltered path keeps its plain index scan.

**Why**: three call sites is not enough to justify a shared `librarySource.ts` yet (CLAUDE.md: no premature abstraction), and the pages differ in what "the toggle" changes — gear/people drop cards with a zero count in the active half and redirect their links to `/library/incoming/grid` vs `/library/gallery`; search instead re-runs the CLIP ranking scoped to that half. Search deliberately keeps its own `source` in the query string (`&source=`) on top of localStorage, matching the page's existing "the query lives in the URL" rule — gear/people only use localStorage, matching their own no-deep-link precedent.

**How to apply**: a fourth page wanting the same toggle should extract the shared bits (type, labels, localStorage helper) into one file — until then, copy the existing pattern from whichever of the three is closest rather than inventing a new shape. The person-list threshold hiding (`ML_PERSON_MIN_FACES`) and the "drop empty cards" rule now read the count for the *active* half, not the global total — a stack invisible on the Gallery tab reappears on Incoming and vice versa.

## The UI files are too big and that is acknowledged (2026-08-20)

**Observation**: `MediaViewer.tsx` (~1480 LOC), `gallery/GalleryShell.tsx` (~1290), `sessions/[id]/SessionGrid.tsx` (~1280), `gallery/FilterPanel.tsx` (~1020). The backend does not have this problem (largest `lib` file ~570 LOC). Splitting them is P2 in the review.

**How to apply**: do not treat the size as licence to add more. When touching one of these substantially, extracting the piece you came for is welcome; a wholesale split is a task of its own, not a side effect.
