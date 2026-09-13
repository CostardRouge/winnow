# Winnow — UI review

*Reviewed at the tree of `343703b` (13 Sep 2026): 39 pages under `src/app`,
`globals.css` at 7,432 lines / 918 classes, 56 screens captured at 1440 × 900,
390 × 844 @2× and in night paper from a local instance fed with a synthetic
library. This document is the numbered register of what stops the interface
from reading as professional, in the form `ARCHITECTURE-REVIEW.md` uses:
findings with an explicit status, then a tiered roadmap. The annotated
screenshots and the before/after mockups live in the companion artifact
("Winnow UI Review", <https://claude.ai/code/artifact/6b69268a-e69f-4bb6-9b8c-8ea85eb3b8d9>),
which cites the same identifiers.*

---

## 1. What is already good — preserve this

- **The tokens.** 28 `@theme` tokens (six surfaces, three inks, one accent,
  five verdict colours, four radii, two shadows), plus ten heatmap tokens in a
  plain `:root`. Every one of the 918 classes is referenced from `src/**/*.tsx`:
  there is no dead CSS.
- **Night paper.** The dark theme redeclares 30 tokens and nothing else, and
  only three component-level dark patches exist (`.btn-primary:hover`, the two
  theme-toggle icons). That is the right shape.
- **The type pairing.** Instrument Serif for display, Space Grotesk for UI,
  JetBrains Mono for numbers; `tabular-nums` on `body`. The login screen and
  the section titles already show what the whole app could feel like.
- **The icon set.** One stroke weight, one 24-grid, drawn in `ui.tsx` with a
  comment per glyph saying what it means.
- **Accessibility basics.** A global `:focus-visible` ring, no bare
  `outline: none` (the four sites that drop it replace it with a box-shadow
  ring), `prefers-reduced-motion` honoured across all 95 transitions.
- **The recent components.** `OptionPicker`, `LibrarySourceTabs`,
  `LoadingOverlay`, `useAnchoredPanel`, `useOverlayDismiss`: the last month's
  work already points at the consolidation this review asks for.

## 2. Findings

Status vocabulary: **P0** = a bug, fix now; **P1** = the visible step to
"professional"; **P2** = system consolidation that moves no pixel on its own.
Measurements are of the screens and stylesheet at the reviewed commit.

### 2.1 Structure — the chrome above the content

| # | Finding | Status |
|---|---|---|
| S1 | **Three stacked header bands** on every Library screen (`library/layout.tsx`: `.topbar` with h1 + strapline, `.shell-head-row` with section tabs + `StatsStrip`, then `GalleryShell`'s `.gallery-controls`): 172 px on desktop, **390 of 844 px on a phone** before the first card; on `/sessions/[id]` the grid starts at 410 px (desktop) / 1,320 px (phone). | P1 |
| S2 | **Settings tab rows clip without a scroll cue**: on 390 px "Database" (`SettingsNav`) and "Failures" (`PipelineNav`) are cut at the right edge, no fade, no wrap. The Pipeline section stacks three navigation levels (Settings › Pipeline › Overview). | P0 (clip) · P1 (levels) |
| S3 | **Section chrome is hand-typed 13 times** (`.topbar` + h1 + `.hint` + `.spacer`) in two different places — server `page.tsx` for `/gear`, `/people`, `/users`; the client panel for `/timeline`, `/heatmap`, `/search`, `/sift` — over **seven toolbar wrapper classes** (`.gallery-controls`, `.filterbar`, `.gear-head`, `.exports-toolbar`, `.trash-head`, `.sift-controls`, `.sift-deck-statusbar`), with `TimelinePanel` borrowing `.gallery-controls` and `PeoplePanel` borrowing `.gear-head`. `.pipeline-body` is the generic body class but is named after one section. | P1 |
| S4 | **Detail pages disagree on their own shape**: `SessionGrid` and `SiftSession` put the entity name in `<h1>` and carry a back arrow despite `AppRail.tsx:13`'s rule; `PersonDetail` puts the section name in `<h1>`, the person in `.person-head-name`, and has no back affordance. | P2 |

### 2.2 Hierarchy and colour semantics

| # | Finding | Status |
|---|---|---|
| H1 | **Every session title and every Timeline chapter date is vermillion** because it is an `<a>` and `a { color: var(--color-accent) }` is the base rule. A column of red headlines reads as alerts, and the accent stops marking anything. | P1 |
| H2 | **Action groups have no primary**: five equal `.seg-btn`s on a session card (Ignore · Export · Geotag · Download · Delete), six on the session page, the destructive one beside the safe ones; icon-only on phones where `title` does not exist. | P1 |
| H3 | **The same count is drawn three or four times**: "10 ready / 0 pending / 2 picks" as three coloured pills (amber for a zero), then a full-width bar with a percentage; on the session page five pills + a bar + the Sift button for "5 of 14 to sort"; five stat tiles with coloured left borders on `/settings/pipeline` to show four zeros. | P1 |
| H4 | **Red and vermillion where nothing is dangerous or live**: "Pause scan" is `.btn-reject`-red (pause is safe and reversible); the three rate sliders have vermillion thumbs and read as three alerts. | P1 |
| H5 | **The absolute filesystem path is the first line of the session page**, in mono, wider than the title (`SessionHeader`); on a phone it wraps over four lines and is the largest text block on screen. | P1 |

### 2.3 Phone

| # | Finding | Status |
|---|---|---|
| M1 | **"N loaded" overlaps the theme toggle** in the session topbar at 390 px (`SessionGrid.tsx`, the trailing `.hint`). | P0 |
| M2 | **Verdict filters wrap into two rows** of 38 px `.btn`s with "Select" alone on the second; the **keyboard hint** ("Keyboard: P pick · X reject …") renders on a touch device. | P0 (wrap) · P1 (hint) |
| M3 | **1,320 px to the first frame** on `/sessions/[id]`, 390 px to the first card on `/library`. | P1 (via S1, H5) |
| M4 | **Viewer on a phone**: the action bar wraps and the "next" arrow drops to a second centred line; the zoom control floats alone in black mid-screen; the info sheet opens by default at 45 % of the height (and is a bottom sheet on desktop too, leaving 570 of 900 px to the photo on a 1440 screen). | P0 (wrap, zoom) · P1 (sheet) |
| M5 | **Seven bottom-bar entries** at 10 px labels; Timeline and Heatmap are ways *into* the library, not daily tools. | P1 |
| M6 | **No control reaches a touch target**: no `min-height` on any control, no `@media (pointer: coarse)`, and the ≤767 px block *shrinks* `.tab` to ≈22 px (`globals.css:4243`). See A3. | P1 |

### 2.4 Component drift

| # | Finding | Status |
|---|---|---|
| C1 | **Five segmented-control families**: `.tabs/.tab` (26 px), `.view-toggle/.view-btn` (24), `.pipeline-tabs/.pipeline-tab` (24, **byte-identical to `.view-btn`**), `.fail-tabs/.fail-tab` (33), `.seg-actions/.seg-btn` (36). `OptionPicker` already emits the first two; none of the four `<Link>` navs and none of the last three route through it. `SessionGrid` draws its verdict filters as `.btn`/`.btn-primary`. | P2 |
| C2 | **Four chip families with the same box**: `.chip` and `.pill` are `rounded-full px-2.5 py-1 text-xs` with different colours; `.tag` is a third; nine `*-badge` classes a fourth. TSX usage 11 / 5 / 4 / 3 — no winner. The 10–11 px overlay badge is re-declared ~13 times with three different radii. | P2 |
| C3 | **Five loader treatments** (`LoadingState`, bare `<Spinner/>`, `<div class="spinner">Loading…</div>` ×9, `<p class="hint">Loading …</p>`, `SkeletonCards`) and **four empty-state classes** (`.empty`, `.empty-state`, `.cal-empty`, `.sift-recent-empty`) with three paddings and two colours; raw `<div class="empty" style={{padding:16}}>Nothing here. 🎉</div>` in the failures sections. `GalleryShell` alone uses three loaders. | P2 |
| C4 | **Three context menus hand-rolled beside `ActionMenu`**: `SearchPage`'s `.ctx-menu` (its own comment says it copies `AssetActionMenu`), `PeoplePanel`'s `.person-menu`, and `AssetActionMenu` itself. Two hand-rolled `.modal-overlay` dialogs in `UsersPanel`, `PersonDetail`, `DedupModals`, `VolumesPanel` next to `ConfirmDialog`; `modal-title` is an `<h2>` in twelve places and an `<h3>` in the shared dialog. | P2 |
| C5 | **183 inline `style={{}}` props** across `src/app` — `DatabasePanel` 15, `ui.tsx` 14 (the shared `EmptyState` and `SkeletonCards` are built from inline flex/grid), `FilterPanel` 13, `RelinkSection` 10, `sections.tsx` 10, `MarksView` 9. | P2 |

### 2.5 Type, spacing and tokens

| # | Finding | Status |
|---|---|---|
| T1 | **35 distinct font sizes.** The 10–12 px band alone carries nine (`9.6 · 10 · 10.24 · 10.4 · 10.56 · 10.88 · 11 · 11.2 · 11.52`), four of them within half a pixel of each other; 12 px is spelled three ways (`text-xs`, `text-[12px]`, `text-[0.75rem]`); 16 sizes are used exactly once. Letter-spacing has 12 values for one job (the uppercase micro label). Font-weight, by contrast, is a real four-step system, and spacing is almost entirely on the Tailwind grid. | P2 |
| T2 | **Nine control heights** (20 / 22 / 24 / 26 / 28 / 32 / 33 / 36 / 38) and no `--control-h` token; `.btn-icon` (36) does not match `.btn` (38), so an icon button beside a text button is 2 px short. | P1 |
| T3 | **Twelve radii for four tokens**: `6px` ×9, `2px` ×6, `4px` ×5, `5px` ×3, plus `rounded-md`/`rounded-lg` re-spelling 6 px and `--radius-sm`; `globals.css:7196` reads `var(--radius-lg, 12px)` while the token is 14 px; `rounded-full` is used 58× with no name. | P2 |
| T4 | **Nine breakpoints for three tiers.** `max-767` (the phone bar, 161 lines) has no `min-768` partner; `min-761`/`max-760` form a second pair 7 px away, so **between 761 and 767 px both the phone and the desktop rules apply**; `min-720` and `min-700` are two more thresholds 20 px apart. | P2 |
| T5 | **Literals that do not flip at night**: five shadows hardcode light ink `rgba(27,24,19,…)` — `.btn`, `.btn:active`, **`.btn-primary`**, `.seg-actions`, `.stats-strip` — while `--shadow-card`/`--shadow-pop` are correctly redeclared; `color: #f4f0e7` (the light `--color-bg`) is typed at four sites; `#ece7da` appears nine times in four spellings with no name (it is the missing `--color-frame-fg`); the modal scrim `rgba(8,6,4,.6)` is copied three times. | P2 |
| T6 | **An orphan hue**: `#3aa99a` (teal) in `gallery/MapView.tsx` for the Leaflet selection, in neither theme's tokens. `layout.tsx`'s two `theme-color` metas duplicate `--color-bg` with nothing tying them back. | P2 |

### 2.6 Accessibility

| # | Finding | Status |
|---|---|---|
| A1 | **`--color-faint` fails AA in both themes**: `#a99f8d` on `#f4f0e7` = **2.30:1**, `#6f6656` on `#16130e` = **3.27:1**. Used 78×, **45 of them on text of 8–11 px**. `#857b69` (light) / `#8c8272` (night) clear 4.5:1 and stay visibly the third step of the ramp. | P0 |
| A2 | `--color-muted` on light paper is 4.07:1 (0.43 short of AA), `--color-accent` on paper 3.84:1, `--color-star` 2.73:1, white on the night accent 3.47:1: fine for large text and icons, not for the 11–12 px copy they carry today. | P1 |
| A3 | **No tap target anywhere reaches 44 × 44** (WCAG 2.5.5) and five control classes sit at or under the 24 px of 2.5.8: `.tag` 20, `.tab` on a phone 22, `.view-btn` / `.pipeline-tab` / `.ctx-*` 24. | P1 |

### 2.7 Polish and copy

| # | Finding | Status |
|---|---|---|
| P1 | **Raw glyph buttons** where every other icon comes from `Icons`: `✕ ↪ ✓ ↶` in `SwipeDeck`'s mobile verdict bar, `⇩ ↻ ☻` in `ViewerActions` and `AssetActionMenu`, a literal `+ Invite a user` on `/users`. | P2 |
| P2 | The busy state on the login and invite submit buttons is the string `"…"`, not `<Spinner sm/>`; their errors use `.login-error` while the 26 other sites use `.error-box`. | P0 |
| P3 | Empty-state copy that names environment variables (`ML_ENABLED=true` on `/people`) is right for an admin but is set as body text; set the names in `code`. | P2 |
| P4 | `global-error.tsx` renders `<button onClick={reset}>` with no class and a `<p>` without `.hint`; neither error page sets a title. | P0 |
| P5 | The Sift deck card is portrait and letterboxes a landscape frame: half the card is black on a phone held upright. Emoji in copy (`Nothing here. 🎉`, `…right now. 🎉`). | P2 |

## 3. Direction

The mockups in the artifact are built from the existing tokens and the existing
type pairing; they introduce three control heights and a six-step type ramp and
nothing else. The five moves, in the order they are visible:

- **A · One header, not three** (S1, S3, M3). A section owns two bands: band
  one names the place (serif title + section tabs, the count at the end), band
  two operates the view. One `PageHeader` component replaces the 13 hand-typed
  topbars and the seven toolbar classes; the strapline is retired (it describes
  the app to someone already in it). Library goes from 172 px to 96 px on
  desktop and from 390 px to ~120 px on a phone; on a phone the tabs scroll
  under the title with an edge fade (S2) and the status filter moves into the
  filter drawer.
- **B · A session card with one thing to do** (H1–H3). Ink title in the UI face
  (a card in a list is a heading; the whole card is the link), a human en-GB
  date, the folder name demoted to a mono aside, the three pills and the bar
  collapsed into **one segmented progress line with a legend**, one primary
  action (Sift, or Export once sorted) and a `⋯` menu holding the rest with
  Delete last and separated. Green and red appear only where a verdict is.
- **C · The session page** (H5, M1, M2, M3). A single 64 px header with
  breadcrumb, title, meta line and actions; the mount path behind an `ⓘ` chip;
  verdict filters as a `.view-toggle` with counts in the labels; Select at the
  far end of the toolbar; the keyboard hint at 11 px in the toolbar and hidden
  under `(pointer: coarse)`; "N loaded" moved to the grid footer. 190 px to the
  grid on desktop, 230 px on a phone, with a full-width 44 px primary. The
  phone bar drops to five entries with Timeline, Heatmap and Gear behind
  "More" (M5).
- **D · Three control heights, six type steps, one chip** (T1, T2, A3, C1, C2).
  `--control-h-sm/md/lg` = 28 / 36 / 44, the icon button taking the same token
  as its text sibling, 44 px for every tappable control under
  `(pointer: coarse)`. A ramp of 11 / 12 / 13 / 15 / 17 / 26 (micro, caption,
  control, body, title, display), micro the only step that may use tracking.
  One `.chip` with `data-tone` (neutral, pick, reject, warn, accent) replacing
  `.pill`, `.tag` and the badges; `OptionPicker`'s two sizes as the only
  segmented control.
- **E · What each colour may mean** (H1, H4). Vermillion = the brand, the
  active rail entry, the focus ring, inline links in prose, the active toggle
  in a set — never a card title, a date, a slider thumb, a count or a Pause
  button. Ink = titles and the primary action. Pick/reject green and red = a
  verdict on a frame, never a count. Amber = attention (pending, paused),
  never a zero. A red button = destructive and confirmed. The test: on any
  screen, count the vermillion elements; if more than two are not the brand,
  the rail or a focus ring, one of them is lying.

## 4. Roadmap

**P0 — bugs, about a day, ships alone:** M1 (move "N loaded" to the grid
footer) · M2 (the filter row in an overflow-x container) · M4 (the viewer
action bar under 400 px; the zoom control anchored to the stage corner) · S2
(Settings/Pipeline tab rows scroll with an edge fade) · A1 (`--color-faint`
to `#857b69` / `#8c8272`) · P2 (a spinner for the "…" busy state) · P4 (a
class on the global-error button).

**P1 — the visible step, one to two weeks, where the effort goes:** S1 + S3
(`PageHeader`, two bands, the strapline retired) · H1–H3 (the session card) ·
H5 + M3 (the session page header and toolbar) · H4 (colour semantics applied:
Pause neutral, sliders ink, counts uncoloured, red only for the destructive
verb) · A3 + T2 (three control-height tokens, 44 px under `pointer: coarse`) ·
M5 (five-entry phone bar with a "More" sheet) · M4 (viewer info as a side
panel on desktop, a collapsed sheet on phones).

**P2 — the system, rolling, per file touched:** C1 (route `.pipeline-tab`,
`.fail-tab`, `.seg-btn` through `OptionPicker`, delete the classes) · C2 (one
`.chip` with tones) · C3 + C4 (one loader pair, one `EmptyState`, one
`ActionMenu`, one modal, no emoji in copy) · T1 (six type steps as tokens,
arbitrary `text-[…]` banned) · T3–T6 (three breakpoints at 640 / 768 / 1024,
shadows through tokens, `--color-frame-fg`, the map's teal named) · C5 (inline
styles out of `ui.tsx`, `DatabasePanel`, `FilterPanel`, the failures sections;
`modal-title` at one heading level) · P1 + P5 (glyph buttons through `Icons`;
the Sift card fitting landscape frames) · S4 (the three detail pages agreeing
on `<h1>` and the back affordance).

## 5. Method and limits

A local Postgres 16 and Redis, `npm run migrate`, `npm run worker` and
`npm run dev`. Four sessions of generated JPEGs (Sony A7C II with two lenses,
iPhone 15 Pro, DJI, with capture dates, apertures and GPS written by exiftool)
were indexed by the real pipeline, so bursts, verdicts, stars, tags and
progress are genuine state. Playwright captured 56 screens at 1440 × 900,
390 × 844 at 2× and in night paper. The stylesheet numbers come from a full
pass over `globals.css` and every `.tsx` under `src/app`. The recipe is in
`docs/memory/frontend.md` ("Running the UI locally for a screenshot pass").

**Not covered:** real photographs (the placeholders are flat gradients, so
thumbnail legibility and the dark viewer with a real RAW proxy are untested);
video, Live Photos and the burst strip; People and Search with ML on (both
rendered their configured-off empty state); map tiles (no network); geocoded
places on the Timeline; the export and Immich flows; the invite screen;
anything that needs a second user. None of the findings depend on those, but a
pass with the real library will add to the P0 list.
