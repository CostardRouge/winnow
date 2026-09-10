# Frontend (`src/app/**`, styling, viewer, PWA)

Read before touching a page or component under `src/app/`, the styling, the viewer/grid interactions, or the PWA.

Seeded 2026-08-20 from `src/app/globals.css`, `next.config.mjs`, `public/sw.js`, `src/app/**` component comments and `docs/ARCHITECTURE-REVIEW.md` §3.5.

## The UI is written in English — all of it (2026-09-07)

**Decision**: every user-facing string is English: labels, buttons, tooltips, empty states, notices, loader labels, weekday and month names, and the server-side fallbacks that surface as copy (`lib/timeline.ts`'s `"Unknown place"`). The maintainer is French and `/timeline` shipped entirely in French — it was the only French island in the app and was translated wholesale on 2026-09-07.

**Why**: the audience is English-speaking and technical first (the product still aims to be elegant for photographers). A half-translated UI reads worse than either language alone, and the drift starts with one page.

**How to apply**: write the copy in English on the first pass — a French draft is a rewrite, not a detail, and it is the mistake to watch for when the conversation itself is in French. Follow the en-GB conventions already in the tree: day before month, `toLocaleString("en-GB")`, `MONTHS = ["Jan", …]` (`gallery/Tree.tsx`), full weekday names (`gallery/CalendarView.tsx`), curly quotes `“ ”` and `’`, never `« »`. There is no i18n layer and none is planned: strings are literals in the JSX, so translating a feature later means touching every file it owns.

## Styling: a "Paper" design system in CSS, not utilities in JSX (2026-08-20)

**Decision**: `src/app/globals.css` (~5900 lines) defines the whole visual language — an `@theme` token block (warm paper surfaces, ink text, one vermillion accent, verdict colours, radii) followed by ~630 semantic component classes built with `@apply` inside `@layer components`. Components carry class names like `.sift-recent-card`, not long utility strings. `cn()` (`src/lib/cn.ts`, a thin `clsx`) composes them conditionally.

**Why**: the UI chrome is deliberately quiet so the photos carry the colour, and the tokens are what keep that consistent across dozens of pages. The full-screen viewer is the one intentionally dark surface (`--color-frame`) — photos read best on black.

**How to apply**: reach for an existing token and an existing component class before inventing either; add a new class to the matching `@layer components` block rather than piling utilities into the JSX. Never hardcode a hex colour that a token already names.

## The brand mark is the sieve, and it lives in five copies (2026-09-07)

**Decision**: the mark is **"Le tri"** — six grains pressing against a hairline screen on the left, two making it through on the right: a lot goes in, little comes out. It replaced the vermillion feather arc, chosen by the maintainer out of the ten candidates kept in `docs/design/logo/` (README there says what each of the other nine gives up). The ranking criterion agreed with him is **legibility at 16 px before meaning** — the feather failed exactly there, its three parallel arcs merging into one curve, which is what prompted the exploration in the first place.

**Observation**: changing the symbol means touching five independent places, not one — `public/icons/icon.svg`, `icon-maskable.svg` and `icon-apple.svg` (three different insets, and the maskable is **inverted**: paper glyph on full-bleed vermillion), then `npx tsx scripts/gen-icons.ts` to re-rasterise the seven PNGs, then `Brand` in `src/app/ui.tsx` (the pill inverts the glyph to `--color-accent-fg`, so it must be `currentColor` throughout), then the hardcoded fifth copy in `public/offline.html` (no CSS bundle reaches that page, so no token can), then `VERSION` in `public/sw.js` because the icons and the offline page are precached. Missing any one of them leaves the old mark live somewhere.

**Traps found while drawing** — the reasons the shipped geometry is what it is: a *comb* of thin parallel strokes always clogs at favicon size, and so does a hairline **ring** (the chooser's version of this mark used hollow circles; production fills them at half opacity instead, letting size and opacity carry "many small in, few big out"); a **dashed** line disappears entirely below ~24 px, so the screen is a solid hairline; a **symmetric** bowl under a centred dot reads as a smiling face, which is why every fan-shaped candidate is asymmetric; and **the inverted copies need higher opacities than the paper ones** (mass 0.68 / sieve 0.45 against 0.5 / 0.32) because fading paper toward a saturated vermillion loses far more perceived contrast than fading vermillion toward paper — the favicon's values go murky in the pill, and the vector at 200 px does not show it.

**How to apply**: judge a candidate as a real 16×16 raster, not a scaled-down vector — they lie in opposite directions — and judge the pill by rendering the real `Brand` markup against the built CSS (`.next/static/chunks/*.css` carries the compiled `globals.css`, so a two-element static page reproduces it without a database). Author in a 24×24 viewBox with `currentColor` so the glyph drops into `Brand` unchanged. Changing the mark does not touch `manifest.ts`, `layout.tsx`'s `viewport.themeColor` or `offline.html`'s theme block — those carry the paper/night backgrounds, not the mark. The `🪶` in `README.md`'s title still shows a feather; it is the maintainer's line to change.

## The icon SET is what puts a mark on a home screen, and this repo is the portfolio's reference (2026-09-10)

**Measured, from a report that Winnow's icon was right on Chrome for iOS and Atelier's was not**: the difference is not the browser, it is one tag. iOS builds a home-screen icon from `apple-touch-icon` **only** — a PNG, square, opaque — and ignores `rel="icon"` whatever its type; with no such link it screenshots the page instead. Chrome for iOS is WebKit, so it reads exactly what Safari reads. Atelier declared an SVG favicon and nothing else, which is the whole of it; it has since copied this repo's set, and `COMMON-PROJECT-SPEC.md` in `second-brain` now carries the rule for every repo of the portfolio, with Winnow named as the worked example.

**So `metadata.icons.apple` in `layout.tsx` is load-bearing, not decoration** — dropping it, or letting the 180px PNG fall out of `public/icons/`, silently costs the home-screen mark on every iPhone while every desktop tab still looks right. `manifest.ts` is the Android/Chrome half and does not cover for it. The seven PNGs and the three SVG sources are listed in «The brand mark is the sieve» above; that entry is the one to follow when the drawing changes.

**`display: "standalone"` is EARNED here, and is the one field of the set another repo must decide for itself.** Winnow's state is on the server, so a home-screen launch in its own storage container costs nothing. An app whose documents live in the browser (Atelier: IndexedDB) would open on an empty gallery, and says `browser` for that reason. Do not copy the field across repos as though it were part of the boilerplate.

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

## An outage is a status bar; the full-page offline screen is the last resort (2026-09-10)

**Decision**: `ConnectionStatus` (`src/app/ConnectionStatus.tsx`, `.conn-*` in `globals.css`, mounted by the root layout outside `.root`) reports an outage as a slim pill in the header band — one line, one verb, `role="status"` — and `public/offline.html` is kept only for a cold navigation with nothing cached. The maintainer's complaint was the takeover itself: the offline card replaces the document, so a blink of the tunnel mid-cull costs the scroll position, the selection and the frame being judged. It also ignored the theme switch, which is the second half of the rule below.

**How it notices, cheapest first**: `offline`/`online` events are free but only fire when the DEVICE loses its network — Winnow's real failure is the opposite (wifi fine, the Optiplex not answering: a Watchtower pull, the tunnel, a Postgres restart), which the browser reports as online. So the component also **observes the global `fetch`** — every screen is fed by one, so a dead server surfaces within a second — and both signals only *raise the question*: nothing is shown until a probe of `/api/health` fails too, which is what kills false alarms from an aborted request. Only a `TypeError` counts (an `AbortError` is the app cancelling its own request). While down the probe **is** the retry loop (2s → 30s backoff, paused while the tab is hidden); while healthy there is **no polling at all** and a good session sends zero extra requests. A 503 from the probe means the app answered and Postgres or Redis did not, and is named as such ("Winnow's database is down") — "can't reach Winnow" would send you looking at the wrong box.

**Traps**:
- An inline `navigator.onLine === false` narrows the property to `true` for the rest of the block, and tsc then rejects the *second* reading (after the await) as a dead comparison — which is the reading that matters. Read it through a call.
- `/api/health` is the only sound probe: public (`PUBLIC_PREFIXES` in `lib/authz.ts`), never cached by the worker, and it answers "is the server there" and nothing else. A 401 would still be a reachable server.
- The offline page cannot be judged by `prefers-color-scheme`: the app's theme is an explicit choice in `localStorage["winnow.theme"]`, so the page runs the same pre-paint resolution as `layout.tsx` and swaps its two media-scoped `<meta theme-color>` tags for the single one that applies. Anything served outside the React tree needs that script or it will contradict the switch.
- The worker answers the failed navigation **without redirecting**, so the document URL is still the page that was asked for: the page can reload itself back into that page, and it does, on `online` and on a 5 s tick. A fallback that needs a tap to leave is the dead end it is trying not to be.
- A root layout that throws (Postgres down at first paint) takes `ConnectionStatus` with it — the bar covers outages that start while the app is *open*, not one that was already there.

**How to apply**: report a transient app-wide condition as a fixed pill at `z-[1300]`, above the viewer, its overlays, menus and modals; do not push the layout down and do not take the page. New chrome outside the React tree (a static fallback, an error document) resolves the theme with the layout's script, never with a media query alone.

## Touch is a first-class input and it is fiddly (2026-08-20)

**Observation**: the viewer and the sift deck hand-roll pointer/touch handling — double-tap returning to the last zoom, pointer events stopped from starting a pan/swipe on interactive overlays, a drag past `FLICK_PX` treated as a deliberate flick, and iOS's synthesized click after a touch explicitly prevented from opening the viewer.

**Why**: this is a phone-first culling tool; each of those lines is a bug someone hit on a real device.

**How to apply**: when adding an overlay or control inside the viewer/deck, stop its pointer events from reaching the gesture layer, and test on a touch device — the desktop mouse path will not reproduce the failure.

## The Incoming/Gallery/All toggle is one shared component (2026-08-24)

**Decision**: `LibrarySourceTabs.tsx` (`src/app/`) is the single source for the segmented Incoming/Gallery/All picker used on `/gear`, `/people` and `/search` — the `LibrarySource` type (`"all" | "incoming" | "gallery"`), the `LIBRARY_SOURCES` labels, the `<LibrarySourceTabs>` component (the exact `.tabs`/`.tab` markup — not `.view-toggle`/`.view-btn`, which two of the three pages used before this and which read as a visually different control from gear's), the `useStoredLibrarySource(storageKey, urlSource?)` restore/persist hook, and `effectiveLibrarySource(source, incomingCount)` for picking one real grid under "All". First tried as three independent hand-rolled copies (2026-08-22); the third copy (search) is what made the drift (different classes) worth fixing rather than tolerating.

**"All" specifics**: it sums Incoming + Gallery wherever a page shows a number — `mergeStats()` in `GearPanel.tsx` for `GearStats` (count/photos/videos summed, capture dates unioned), `incoming_*_count + gallery_*_count` inline in `PeoplePanel.tsx`. There is no single grid that shows both halves at once (`/library/incoming/grid` and `/library/gallery` are separate routes), so anywhere a card/row must link to ONE, `effectiveLibrarySource` picks Incoming when that specific item has anything there, Gallery otherwise — never a page-wide fixed default, since an item fully exported already would otherwise link to an empty Incoming grid. On `/people`'s bulk-selection links (multiple people, no single row to defer to) "All" simply falls back to Incoming. On `/search`, "All" needs no special case at all: `api/search` already runs unfiltered when `source` is missing or unrecognized, and `all` is treated as exactly that.

**Why not `"all"` as the default tab**: only newly reordered to be *first* in the list, per an explicit ask — the remembered/default source (no saved localStorage, no URL override) is still `"incoming"`, unchanged from before this control existed, so returning users and fresh visitors keep seeing what they always did. `useStoredLibrarySource`'s `urlSource` param exists only for `/search` (query-string-shareable, per that page's "the query lives in the URL" rule); gear/people pass nothing and rely on localStorage alone.

**How to apply**: a new library-scoped page reaches for `LibrarySourceTabs`/`useStoredLibrarySource` directly rather than hand-rolling another copy. The person-list threshold hiding (`ML_PERSON_MIN_FACES`) and gear's "drop empty cards" rule read the count for the *active* half (summed, under "All") — a stack invisible on the Gallery tab reappears on Incoming or All.

## Deduplication triage is paged server-side and off the shared poll (2026-09-02)

**Decision**: `/settings/pipeline/failures/duplicates` reads its own `GET /api/failures/duplicates` (grouping, zone classification, filtering, facets and paging all server-side in `src/lib/duplicateList.ts`), not the `useFailures()` payload every other family page polls every 5 s. The dedup slice was removed from `GET /api/failures` entirely.

**Why**: it is the one family that reaches thousands of rows, and it was being serialized into every tick of a poll that five other pages share — while the page itself rendered every group at once, with no paging and a filter that only searched what had already been shipped. The maintainer's library carries ~5000 hits; the page was unusable at that size.

**How to apply**: the page owns its query (scope, path search, RAW-in-Gallery, sort, offset) and reloads on change or after an action — do not put it back on an interval. `buildGroups()` reads the whole table once per request on purpose (the grouping key is the hash but every filter is derived per path); that is affordable at a few thousand rows and is the documented trade — if the table ever grows an order of magnitude, that is the thing to revisit, not the paging.

**Why not `LibrarySourceTabs`**: the scope picker wears the same `.tabs`/`.tab` classes but is deliberately its own list — a group is a *set* of copies, so it needs values that toggle has no meaning for (`mixed` = the same bytes on both sides, `elsewhere` = Export/unregistered), and every tab carries a count. Reusing the component would have meant widening `LibrarySource` for one page.

## A bulk destructive action states its RULE, not its file list (2026-09-02)

**Decision**: "Collapse N resolvable" resolves whole groups in batches, and the endpoint takes the **filter**, not a client-built list of groups: the server re-derives which groups match and which copy survives with the same code that rendered the preview. The rule is narrow on purpose — a lone Final/Export copy that is *also* the library entry (or with no library entry), else a live library entry with no protected copy. Everything else stays manual.

**Why**: the excluded case that matters is a live library entry plus a protected copy elsewhere (an Export volume mirroring an incoming original). Collapsing onto the protected copy would relink a live asset onto a view-only volume — moving the library's idea of where that photo lives, across roots, unasked — and the right answer there is usually to delete nothing. Passing the filter rather than a list also means a page that went stale can never delete a copy the rule would no longer pick.

**How to apply**: the client loop must stop on **lack of progress** (`remaining` not shrinking), never on `remaining === 0`: a group whose deletions are refused keeps matching the rule forever. Every group still goes through `keepOneCopy`, so the path whitelist, view-only refusal and relink-before-unlink ordering are untouched — the bulk path adds a picker, not a shortcut.

## The UI files are too big and that is acknowledged (2026-08-20)

**Observation**: `MediaViewer.tsx` (~1480 LOC), `gallery/GalleryShell.tsx` (~1290), `sessions/[id]/SessionGrid.tsx` (~1280), `gallery/FilterPanel.tsx` (~1020). The backend does not have this problem (largest `lib` file ~570 LOC). Splitting them is P2 in the review.

**How to apply**: do not treat the size as licence to add more. When touching one of these substantially, extracting the piece you came for is welcome; a wholesale split is a task of its own, not a side effect.

## Modal backdrops dismiss on the *press*, not the click (2026-08-25)

**Decision**: `useOverlayDismiss(onDismiss)` (`src/app/useOverlayDismiss.ts`) is the shared way to close a `.modal-overlay`. It spreads `onPointerDown`/`onClick` onto the overlay and fires only when both ends of the gesture landed on the backdrop itself.

**Why**: a bare `onClick={onClose}` on the overlay also fires when a drag that *started inside* the dialog is released outside of it — the browser dispatches the click on the nearest common ancestor of press and release, which is the overlay. Panning the Leaflet map of `LocationPickerModal` past the modal's edge closed the geotag flow; selecting text in an export-name field did the same. The inner `onClick={(e) => e.stopPropagation()}` on the dialog does not help (the click never travels through it) and is redundant once the hook is used.

**How to apply**: new modals use the hook (`{...backdrop}` on the overlay) instead of `onClick={onClose}`; pass a closure for a guarded close (`() => { if (!busy) onClose(); }`). The hook lives at `src/app/` on purpose — it started under `exports/` and had to move once a third modal needed it. Modals still on the bare `onClick` (users, settings/pipeline, people, `ChangePasswordModal`, `DeleteSessionModal`) carry the same latent bug; convert them when you touch them.

## The Timeline derives chapters per request and never stores them (2026-09-03)

**Decision**: `/timeline` (`src/app/timeline/`, `src/lib/timeline.ts`, `GET /api/assets/timeline`) reads the library as chapters — a stay in a place, across session folders — derived on every request. Three cut rules (place / time / hybrid, hybrid default) share one SQL scan that returns **one row per run**, then a pure `absorbRuns()` folds the crumbs; covers and a spread sample of ids come from two bounded per-chapter queries. Tiles are fetched per chapter on first sight through `/api/assets?ids=` (the shared `GRID_SELECT`), so a tile, its badges, its rating and the viewer are the gallery's own.

**Why**: a session is a directory, never a leg of a trip; the Calendar cannot cross a month and has no notion of place. Deriving keeps re-derivation safe — the same reasoning bursts use — so what a human edits later (a name, a forced split or merge) must be stored as a *correction* to the derivation, never as a copy of the chapters. Storing chapters would let the first re-indexed photo in a period break the cut.

**Choices that are not obvious from the code**: the stream is deliberately **not** react-window virtualized — a chapter's height depends on its content, which react-window cannot size; `content-visibility: auto` on `.tl-chapter` plus the lazy tile rows is the cheap path. Place granularity is **automatic** (Région → Département → Ville, first level yielding 6–30 chapters) and the chosen level is returned and shown as a pinnable chip: the maintainer accepted the auto cut on the condition that it is visible and pinnable, because a cut that changes under the fingers is not trusted. Days are read in the chapter's **local day** from `round(medianLon / 15)` — `capture_date` is UTC and no timezone column exists — and the offset is always stated. "Ville" alone was rejected as default (a day on the road makes six chapters), "Temps" alone too (a nine-day stay breaks every night); the mockups that settled this are linked from the plan, not the repo.

**How to apply**: a new reading option goes into the URL (`mode`, `gran`, `source`) like the gallery's filters. Undated media are counted and shown, never silently dropped. Do not add a stored chapter entity — extend the corrections model (`docs/memory/database.md` once migration 0040 lands).

## /gear draws no gear: the illustrations are gone, and there are eight layouts (2026-09-07)

**Decision**: the generated line-art portraits (`CameraArt.tsx`, `LensArt.tsx`, and the drawing half of `lib/gearArt.ts`) are deleted. `/gear` now renders the library's own numbers through eight layouts the user picks from a toggle: **Stack** (the default — one 100 % bar per body split by its glass, plus one for the whole library), Index (an aligned inventory sheet), Cards (one card per body, the tally as the hero figure), Blocks (the kit as one surface, area ∝ media), Timeline (service spans on a shared year axis), Coverage (every lens on a logarithmic millimetre axis), Marks (focal length × aperture, sized by use) and Record (one printed sheet per body, in the display serif). The choice is remembered in `winnow.gear.view`, next to the source tab's `winnow.gear.source`.

**Why**: the illustrated shelf was borrowed from another photographer's site (im-robin.com) and the maintainer wanted the feature without the borrowed form. Beyond authorship: a drawing of a camera says nothing the library knows, while the EXIF knows *when* a body was in service and *what focal lengths* the bag covers — neither of which the old design showed. Several layouts rather than one replacement because "what have I shot with" is really several questions, and no single arrangement answers them all. **Stack is the default on the maintainer's explicit pick** (2026-09-07): proportion before number is what he wanted to see first; Index, the first default, is the densest and stays one click away.

**How to apply**: every layout receives a finished `Kit` from `src/app/gear/model.ts` (`buildKit(cameras, source, sort)`) and only decides how to draw it — tallies, links, tooltips and the relative weights are derived once so two views can never disagree. A new layout is a component plus an entry in `VIEWS`; do not re-derive anything in it. `src/lib/gearSpec.ts` is what survived of `gearArt.ts`: the body archetype (shown as a plain "Reflex / Mirrorless / Phone / Drone" label) and the lens optics parser (the name wins where it states a range, the recorded EXIF fills the rest).

**Composition layouts (Stack, Blocks) — the ink rule**: a segment's tone comes from `shareInk(share)` in `model.ts`, an ABSOLUTE sequential ramp (one hue, light for a sliver, dark for the bulk), never from its rank in the bar. A tone derived from "biggest, second, third" repaints every surviving segment the moment the Incoming/Gallery tab changes the set around it, and a colour that moves under the same piece of glass means nothing. The two layouts deliberately use **different denominators**: Stack reads share of its own bar (each bar is its own 100 %), Blocks reads share of the whole library (area already means media there, so a per-row tone would paint the drone's single lens-less tile darker than a 6,000-frame zoom). Both divide a body by `KitPart` — lenses **plus** the untagged remainder — because a part-to-whole picture that drops the remainder doesn't add up to the number printed beside it. **Blocks sizes its own rows in pixels and the surface grows with the kit** (2026-09-10): a row is `ROW_FLOOR + share × BUDGET` px, computed in `BlocksView.tsx`, and the container has no height of its own. The floor used to be a *fraction* of a container fixed at 520px, which reads as safe and is not: the fraction is relative to a total that grows with the bodies, so seventeen of them divide 520px into ~30px rows whatever the floor says, and every two-line label is cut through the middle. A minimum only means something in the unit the text is drawn in. Same reason the `.gear-blk-*` line heights are declared in `globals.css` rather than inherited — the floor is arithmetic against them — and why a row under `TWO_LINES_AT` drops its count line and lets the tooltip carry it, the vertical twin of the `LABEL_AT` rule for narrow tiles.

**Charts**: Marks is built from positioned elements on percentage tracks, not SVG — an `<a>` inside an `<svg>` costs the client-side navigation, and every mark has to stay a link into the grid. Marks and Coverage share one scale (`focalAxis` in `model.ts`) so the same lens sits at the same spot in both. Two lenses at the same aperture overlap into one bar, so marks carry a 2px ring of `--color-bg`; label placement is a greedy pass that **drops** a name rather than print it over one already placed, and only the busiest few are named at all.

**Traps in the axis layouts**: the ruler, the gridline layer and the lanes are separate CSS grids, so their column widths must stay FIXED and identical — a `max-content` figures column sizes per row and the ruler silently stops lining up with the tracks it annotates. The timeline's axis is padded out to whole years (Jan 1 of the first to Jan 1 of the year after the last) so bars sit inside it, and a bar carries a `min-width` so a single day of use still leaves a mark. The coverage axis is logarithmic on purpose — a linear one crushes a whole wide-angle kit into the first centimetre of a 400mm library — and its labels are dropped when they fall within 5 % of the previous one. The Cards wall uses CSS `columns`, not `grid`: card height follows how much glass rode on the body, and a grid leaves a hole the height of the tallest card in every row. Record and Marks cap their measure (1100px / 960px) — the rest of the shelf is full-bleed, but a sheet that wide wraps its spec values and a plot that wide scatters seven marks over a metre of screen.

**The layout toggle is not a segmented control any more**: eight options overflowed a phone, so `/gear` renders `OptionPicker` (below), which draws itself as a menu past four options.

## One picker for "one of N", and its form follows the count (2026-09-07)

**Decision**: `src/app/OptionPicker.tsx` is the shared control for picking one value out of N. `form="auto"` draws a **segmented row up to four options and a menu above** — a count, never a viewport measurement. `size` picks the scale: `md` emits `.tabs`/`.tab`, `sm` emits `.view-toggle`/`.view-btn`, **byte-identical to what the call sites hand-rolled**, which is what makes migrating them safe: every contextual override in `globals.css` keys on the container (`.gallery-controls .view-btn`, `.facet-head`, `.pl-toolbar`, `.sift-controls`) and keeps applying untouched. `LibrarySourceTabs` now renders one internally and keeps its public API (three pages import it). Migrated so far: `/gear`'s layout and sort, `LibrarySourceTabs`, and `/heatmap`'s three groups (Reading, Measure, Granularity); the ~11 other button-based groups all have ≤ 4 options, so `form="auto"` will leave them pixel-identical whenever the sweep happens. The `<Link>`-based navs (`library/layout.tsx`, `settings/SettingsNav.tsx`) stay out — they are navigation, and a listbox is the wrong role for them.

**Why a count and not a measurement**: it is deterministic, renders the same on the server and the client, needs no `ResizeObserver`, and cannot change under the fingers while the page settles. Its limit is stated at `SEGMENT_MAX`: four *long* labels on a 320px screen would still overflow, and `ThumbStrip`'s observer is the escape hatch on the day that case exists.

**Why a listbox and not a menu**: it picks a value, so `role="listbox"`/`role="option"` + `aria-selected`, not `menu`/`menuitem`. It is also the first control here with arrow keys, Home/End and focus-return-to-trigger on Escape — no other menu in the codebase does any of that.

**The menu form's real payoff is on touch**: each option carries a `hint` shown as a second line. That sentence used to live only in a `title`, which does not exist on a touch screen, so eight layout names on a phone were eight unexplained words.

**Migrating a group of ≤ 4 still buys something** (2026-09-08): nothing moves on screen — that is the point of the byte-identical markup — but the call site stops re-deciding the markup, the `active`/`aria-pressed` pair and the `title` for itself, the `hint` becomes a field of the option list rather than an inline ternary, and the group gets the menu form the day it grows a fifth entry. `/heatmap` is the worked example: its Measure row had no `title` at all, so the migration is where the four measures gained the sentence saying what each one counts (`Measure.hint` in `src/lib/heatScale.ts`, beside `lo`/`hi` — the labels live with the measure, not with the picker, so the list, the legend and the tooltips cannot drift apart). A group with its own visual family stays out: `HeatMatrix`'s "By volume / By last seen" is a `.heat-chip` row inside the panel, not a `.view-toggle`.

**Placement lives in `useAnchoredPanel`** (`src/app/useAnchoredPanel.ts`), extracted from `ActionMenu` and adopted by both: the measure-then-place, the flip above / clamp to an 8px gutter, and the four dismissal listeners (mousedown outside, Escape, resize, **capture-phase** scroll). `onClose` is held in a ref so the listeners depend on `open` alone — with it in the dependency array, a caller passing an inline arrow re-attaches all four on every render.

**Two traps this cost**:
- The hook's panel spends its first frame **measured but `visibility: hidden`**, and `.focus()` on a hidden element is a silent no-op. That swallowed the whole keyboard path until the hook started returning `placed`; anything that touches the panel's DOM must wait on it, not on `open`.
- **`.picker-*` was already taken** — by the Volumes folder browser (`.picker-list`, `.picker-row`, `.picker-bar`) and the geotag location picker (`.picker-map`, `.picker-pin`). A new `.picker-list` silently inherited `max-h-56` + `overflow-y-auto` and hid half the options behind a scroll: the exact bug the component exists to fix, reintroduced by a name. The component's classes are `.opt-*`. `grep -o "\.picker[a-z-]*" globals.css | sort -u` before claiming a prefix.

## A re-derived view says so with one blurring overlay, not a second loader (2026-09-07)

**Decision**: `LoadingOverlay` (`src/app/ui.tsx`, class `.zone-loading-overlay` in `globals.css`) is `LoadingState`'s exact spinner + label, drawn as a card floated over its zone with `backdrop-filter: blur(3px)` — the modal treatment minus the dialog. `/timeline` renders it as its **only** loader: the first read draws it over an empty `.tl-body`, every later one (chapter rule, place grouping, library source, a chapter edit, "Retry") over the previous answer, which stays visible, blurred and unclickable. Its label names the change being applied (`readingLabel()` diffs the previous `{mode, gran, source}` against the new one), not a generic "loading".

**Why**: the timeline is derived from a full scan on **every** option change (no cache yet), so a click buys seconds of silence; the maintainer asked for the feedback before the performance work, and asked explicitly that the first-load and the re-derivation loaders be the *same* object — so the zone never changes shape between "nothing yet" and "re-reading". Blurring rather than clearing keeps the old answer as context while making it read as stale; taking the pointer events is the point, since clicking a chapter that is about to be replaced is a bug waiting to happen. The controls sit outside the overlay on purpose — changing your mind mid-derivation just cancels the in-flight read.

**How to apply**: the zone that hosts it must be `position: relative` (`.tl-body` is, and covers the spine too since a change re-derives it as well); `.zone-loading` gets `flex-none` inside the overlay or it stretches. Reach for it when a view is **re-derived** (the whole answer is replaced); keep `.zone-loading` for a first fill with nothing behind it and `.zone-loading-more` for a feed being *extended* — a paged grid must not blur what it is about to append to. Client-only filters (the timeline's "lieux déduits" toggle) fetch nothing and must not raise it.

## `router.refresh()` does not re-render the ROOT layout (2026-09-07)

**Decision**: `FeaturesProvider` (`src/app/FeaturesProvider.tsx`) holds the feature flags in state, seeded by the root layout's server read and re-seeded when that value changes; `/settings/features` pushes the answer PATCH just confirmed into it through `useSetFeatures()`.

**Why**: measured — after `PATCH /api/features`, `router.refresh()` re-rendered the route's own server components and the rail (which lives in `layout.tsx`) did not move until a full page load. A switch that only writes to the database therefore *looks broken* while you stay on the page.

**How to apply**: anything rendered by the root layout that a page can change needs this shape — server read for the first paint, a client mirror for the change. Do not reach for `router.refresh()` to update the rail, and do not fetch the flags again from the browser (an entry point that appears a beat after the paint reads as a glitch). The server stays the source of truth; the context is a mirror, never a second one.

## An optional section is hidden AND unreachable (2026-09-07)

**Decision**: a section behind a feature flag loses its rail entry, its pages answer `404` (`requireFeature`), and the API routes it owns answer `404` too (`featureOff`) — `src/lib/featureGate.ts`. `GET /api/capabilities` states `media.timeline` so Atelier can say "this instance does not serve a timeline" instead of guessing from a 404.

**Why**: hiding only the rail entry leaves the feature reachable by bookmark, by typed URL and by a client app — which is exactly what "the Timeline is not mature enough to be used" has to prevent. Atelier reached the same conclusion from the other side and already reads `media.timeline` (`shared/sources/winnow/client.ts`, `hasTimeline`), treating only an explicit `false` as "no".

**How to apply**: gate a route only where the feature owns it outright. `GET /api/people` stays open even with People off — the gallery's person facet falls back on it to name a deep-linked id, and filtering by person is a *gallery* capability; `/api/facets` (gear's lens/device chips) likewise. Every gated handler carries a one-line comment saying why the route is its feature's alone. The one entry point outside the section itself that does follow the flag is the viewer's face box/chip link to `/people/:id` (`MediaViewer.tsx`, `linkable`) — it would 404.

## Tailwind 4's `@theme` silently drops non-namespaced tokens (2026-09-07)

**Trap**: `@theme { --heat-0: #efe9dd; }` emits **nothing**. Tailwind 4 only carries custom properties that fall in one of its own namespaces (`--color-*`, `--radius-*`, `--font-*`, `--shadow-*`, `--ease-*`, …); anything else is dropped with no warning and no build error. The symptom is a component that paints transparent while `getComputedStyle(document.documentElement).getPropertyValue('--heat-0')` returns `""` — and it costs a render to notice, because every other token on the same page works.

**How to apply**: declare a token either under a Tailwind namespace, or in a **plain `:root` block** outside `@theme` — which is what the heatmap ramp does, with the reason written at the declaration. Note the asymmetry that hides the bug: the night overrides live in `html[data-theme="dark"]`, an ordinary CSS rule, so *those* are emitted verbatim and only the light half disappears.

## The Heatmap is four readings over one measure and one ramp (2026-09-07)

**Decision**: `/heatmap` (`src/app/heatmap/`, `src/lib/heat.ts` + `heatScale.ts`, `GET /api/assets/heat/{days,places}`) reads the library as a distribution, four ways behind one segmented control — **Both** (calendar + binned map, cross-filtered), **Matrix** (places × months, no map), **Map** (full-width map + a month scrubber), **Tinted** (one calendar, place as a foot stripe). All four share ONE measure and ONE ramp; the layouts are variations, the sharing is the design. Behind a feature flag, **off by default** — nothing about it is unfinished, it is a question of whether you want the rail slot.

**The measures** (`heatScale.ts`): volume · keepers · keeper rate · **backlog**, the default. Backlog is the one that is uniquely Winnow's — a map of "these three weeks have never been culled" is a work queue, not a statistic. Keeper rate returns `null` under `RATE_FLOOR` (20 frames) and draws neutral rather than flattering, and the page states the floor: an automatic decision nobody can see is one nobody trusts, the rule the Timeline's granularity chip already follows. The ramp uses **fixed fractions, never quantiles** — a quantile scale re-bins itself when the filters change, so the same day changes colour without its content changing.

**Choices that are not obvious from the code**: the bins are the reverse-geocoding cells that already exist (`places(cell_lat, cell_lon, precision_m)`), so there is no clustering pass and no PostGIS — but the bin size does not refine on zoom, which the panel says out loud; the map marks keep a constant **pixel** size rather than covering their cell on the ground, so a bin is readable at world zoom; the ramp's top is read over every day, never the brushed subset, or two views of the same library could not be compared; the **busiest place gets no tint** in the tinted reading (it is home for most libraries, and tinting it stripes four cells in five so the trips stop reading as runs) and the key names the place the rule applies to. Undated and ungeotagged media are counted beside the view, never silently dropped.

**How to apply**: a new reading goes in the URL (`view`, `measure`, `gran`, `from`/`to`, `place`) like the gallery's filters and the Timeline's. The hand-off to the grid is the ordinary `date_from`/`date_to` pair the Calendar already uses — the heatmap invents no filter of its own. Do not add a third route: both reads are one scan each and serve every panel (see `docs/memory/database.md` on why that matters more than it looks).
