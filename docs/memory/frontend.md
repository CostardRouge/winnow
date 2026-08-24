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

## The Incoming/Gallery/All toggle is one shared component (2026-08-24)

**Decision**: `LibrarySourceTabs.tsx` (`src/app/`) is the single source for the segmented Incoming/Gallery/All picker used on `/gear`, `/people` and `/search` — the `LibrarySource` type (`"all" | "incoming" | "gallery"`), the `LIBRARY_SOURCES` labels, the `<LibrarySourceTabs>` component (the exact `.tabs`/`.tab` markup — not `.view-toggle`/`.view-btn`, which two of the three pages used before this and which read as a visually different control from gear's), the `useStoredLibrarySource(storageKey, urlSource?)` restore/persist hook, and `effectiveLibrarySource(source, incomingCount)` for picking one real grid under "All". First tried as three independent hand-rolled copies (2026-08-22); the third copy (search) is what made the drift (different classes) worth fixing rather than tolerating.

**"All" specifics**: it sums Incoming + Gallery wherever a page shows a number — `mergeStats()` in `GearPanel.tsx` for `GearStats` (count/photos/videos summed, capture dates unioned), `incoming_*_count + gallery_*_count` inline in `PeoplePanel.tsx`. There is no single grid that shows both halves at once (`/library/incoming/grid` and `/library/gallery` are separate routes), so anywhere a card/row must link to ONE, `effectiveLibrarySource` picks Incoming when that specific item has anything there, Gallery otherwise — never a page-wide fixed default, since an item fully exported already would otherwise link to an empty Incoming grid. On `/people`'s bulk-selection links (multiple people, no single row to defer to) "All" simply falls back to Incoming. On `/search`, "All" needs no special case at all: `api/search` already runs unfiltered when `source` is missing or unrecognized, and `all` is treated as exactly that.

**Why not `"all"` as the default tab**: only newly reordered to be *first* in the list, per an explicit ask — the remembered/default source (no saved localStorage, no URL override) is still `"incoming"`, unchanged from before this control existed, so returning users and fresh visitors keep seeing what they always did. `useStoredLibrarySource`'s `urlSource` param exists only for `/search` (query-string-shareable, per that page's "the query lives in the URL" rule); gear/people pass nothing and rely on localStorage alone.

**How to apply**: a new library-scoped page reaches for `LibrarySourceTabs`/`useStoredLibrarySource` directly rather than hand-rolling another copy. The person-list threshold hiding (`ML_PERSON_MIN_FACES`) and gear's "drop empty cards" rule read the count for the *active* half (summed, under "All") — a stack invisible on the Gallery tab reappears on Incoming or All.

## The UI files are too big and that is acknowledged (2026-08-20)

**Observation**: `MediaViewer.tsx` (~1480 LOC), `gallery/GalleryShell.tsx` (~1290), `sessions/[id]/SessionGrid.tsx` (~1280), `gallery/FilterPanel.tsx` (~1020). The backend does not have this problem (largest `lib` file ~570 LOC). Splitting them is P2 in the review.

**How to apply**: do not treat the size as licence to add more. When touching one of these substantially, extracting the piece you came for is welcome; a wholesale split is a task of its own, not a side effect.
