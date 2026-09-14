# Winnow — Settings interface review

*Reviewed at 19 pages and ~6,900 LOC under `src/app/settings/` (plus
`ControlPanel.tsx`, which the Pipeline pane renders). This document is the
state-of-the-union for the Settings section, in two halves: **the form**
(§1–§2, findings 1–13) — what the Paper system gets right there and where it is
not applied — and **the substance** (§3–§4, findings 14–26) — whether this is the
right set of settings at all, where the 99 knobs actually live, and the eight
that are missing. Nothing here is a pipeline or data finding;
`ARCHITECTURE-REVIEW.md` owns those. File references are to the tree at
`343703b`.*

A companion artifact renders the before/after mockups in the app's own tokens
(light and night), published from the session that produced this document. The
document is the record; the artifact is the picture.

---

## 1. The read

The section is not badly built — it is **unevenly finished**. It grew one verb
at a time, each addition reasonable in isolation, and the aggregate now reads as
an admin console that happens to contain a settings page rather than the
reverse. Three numbers carry the diagnosis:

| Measure | Count | Where |
|---|---|---|
| Pages under `/settings` | 19 | 14 of them the pipeline console |
| Nav bars stacked before the first row of content | 3 | `/settings/pipeline/failures/*` |
| Distinct "loading" treatments | 5 | one section, none of them the shared component |
| Inline `style={{…}}` | 63 | 15 in `DatabasePanel.tsx` alone |
| Knobs across four tiers | 99 | 11 of them managed from a Settings page (§3) |

What holds up, and must survive any rework:

- **The token system.** One `@theme` block, ~630 semantic classes, a night
  theme that redeclares only colour. Nothing below asks for a new palette.
- **Live counts in the nav.** `PipelineNav` and `FailuresNav` badge every tab
  off the shared `/api/stats` poll. The nav is a dashboard, which is right.
- **Failure families are real URLs**, so a deduplication list can be linked and
  reopened; dedup pages server-side, off the shared poll.
- **`/settings/import` is the finished pane** — own component classes, no
  inline styles, real busy and empty states. It is the internal reference.

---

## 2. Findings

### Tier A — the shape of the section

These change routes and navigation — the chrome *around* the panes, not their
contents, which is why step 1 of the roadmap can land before any of them is
settled. What they need is a decision rather than a queue position: A1 changes
every URL's depth and A3 is a design question of its own.

**A1 — Three tab bars, three visual families, stacked.** `.tabs` (pill, accent
wash, `settings/layout.tsx:26`) above `.pipeline-tabs` (segmented, bordered,
count badges, `pipeline/layout.tsx:17`) above `.fail-tabs` (a third shape,
`failures/layout.tsx:19`). On `/settings/pipeline/failures/duplicates` that is
three nav rows plus an intro `.filterbar` before the first group card — and on a
phone, three independent horizontal scrollers stacked, each hiding its own
overflow. **Fix**: depth 1 becomes a persistent left rail grouped by intent,
depth 2 stays the page, depth 3 demotes to a chip row inside the Failures pane
(families are a filter of one list, not a level of navigation). A breadcrumb
carries the position the tabs were carrying. *Status: open.*

**A2 — An operations console and a switch list presented as peers.** 14 of the
19 pages are the pipeline (5,290 LOC); the actual configuration is two panes,
Features (130 LOC) and Volumes (509 LOC). The top tab bar gives "Pipeline" and
"Features" the same weight. **Fix**: name the split in the rail — **Operations**
(what the pipeline is doing now), **Library** (volumes, import), **System**
(sections, database, access). Same routes, same code; the grouping is what tells
you which page you want. *Status: open.*

**A3 — No page describes the instance.** `settings/page.tsx:7` redirects
straight to Pipeline, so nothing answers "what is this box, what version, is
everything running" — the first question after a Watchtower pull. **Fix**: a
landing pane composing figures that already exist behind endpoints — build,
worker liveness, the nine queues at a glance, last successful scan, database
weight, which sections are on, disk headroom per volume. Composition, not new
data. *Status: open; which six figures earn the top of the page is a design
question of its own.*

**A4 — Half the settings are not in Settings.** Users live at `/users`,
reachable only from the account popover (`AppRail.tsx:163`); change password is a
modal in that popover; the theme switch is in the rail. **Fix**: fold Users and
an Account pane (display name, password, theme, default library source) into
Settings › System. The popover keeps sign-out and a link — a popover is a
shortcut, not a home. *Status: open.*

### Tier B — the system exists; it is not applied here

Every fix in this tier is "use something the codebase already has". Cheapest
wins on the list, and the ones that most change how finished the section feels.

**B5 — Five ways to say "loading" in one section.**
`volumes/VolumesPanel.tsx:132` (`<p class="hint">Loading volumes…</p>`),
`database/DatabasePanel.tsx:132` ("Measuring the database…"),
`pipeline/PipelineAssetList.tsx:470,487,763` + `scanning/Scanning.tsx:199` +
`MlQueuePanel.tsx:163` (`<div class="spinner">Loading…</div>`),
`features/FeaturesPanel.tsx:90` (`<Spinner />`), and
`volumes/VolumesPanel.tsx:313` (`.picker-msg`). `ui.tsx` exports
`LoadingState`, `SkeletonCards` and `LoadingOverlay`; the section uses none of
the first two. **Fix**: the rule `docs/memory/frontend.md` already states —
skeleton in the shape of the rows that are coming for a first fill,
`LoadingOverlay` for a re-derivation over an answer already on screen, `Spinner`
for a small inline fetch. Delete the bare `<p class="hint">` waits: a sentence
in muted grey is indistinguishable from content. *Status: open.*

**B6 — No page-header pattern, so six panes have four shapes.** Features opens
with a `.control` card and an `h2`; Database and Volumes with a `.filterbar`
holding a paragraph and a button; Failures with a bare `span`. Inside the panes,
every `h3` carries its margins inline — 7 of them, no two guaranteed to match
(`DatabasePanel.tsx:173,258,295`, `failures/sections.tsx:132,227`,
`RelinkSection.tsx:167`, `MissingSection.tsx:245`). **Fix**: two component
classes in `globals.css` — `.pane-head` (title, one-line description, actions
slot) and `.section-head` for the `h3` level. The 7 inline margins then delete
themselves. *Status: open.*

**B7 — 63 inline styles against a system whose stated rule is not to.**
`DatabasePanel` 15 · `failures/sections` 10 · `RelinkSection` 10 ·
`DuplicatesFailures` 8 · `MissingSection` 6 · `VolumesPanel` 4 · `DedupModals` 4
· six others 1 each. The worst is `DatabasePanel.tsx:214-247`: a 34-line share
meter assembled from raw pixel values with `var(--color-accent)` written into
JSX. **Fix**: add `.meter` / `.meter-fill` and use it for the table share bar,
the import progress and the search-index coverage — three call sites already
want it. Most of the rest are margins that `.section-head` (B6) makes
unnecessary. *Status: open.*

**B8 — Emoji standing in for the icon set.** `ControlPanel.tsx:234` ("⏸ Pause
scan" / "▶ Resume scan"), `:334` ("🛰 Backfill drone telemetry"), `:353`,
`faces/FacesText.tsx:174`, `search/SearchIndex.tsx:177`, and "Nothing here. 🎉"
in five empty states (`sections.tsx:178,246`, `MissingSection.tsx:290`,
`DuplicatesFailures.tsx:524`, `pending/page.tsx:19`). They render in a different
family on every platform, carry their own colour into an ink-only chrome, and
cannot take a hover state. **Fix**: four glyphs added to `Icons` (pause, play,
satellite, sparkle-search) covers every button; empty states keep the sentence
and lose the emoji — `EmptyState` already takes an icon. *Status: open.*

**B9 — A native `<select>` where the shared picker belongs.**
`VolumesPanel.tsx:179` renders the volume type as a `<select class="select">` of
three options, while `OptionPicker` is the documented control for "one of N" and
gives each option the hint line a native option list cannot. The hints already
exist as `VOLUME_TYPES[].hint` in `lib/volumes.ts` — the add-volume modal shows
them, the table row throws them away. *Status: open.*

### Tier C — interaction

**C10 — The most destructive action in the app is a browser `confirm()`.**
`VolumesPanel.tsx:90` removes a volume — deleting its indexed media and sessions
from the database — behind `window.confirm` with counts interpolated into a
string carrying literal `\n\n`. It ignores the theme, cannot lay the numbers
out, cannot mark the reassuring half (*the files on the NAS are not touched*) as
reassuring, and in a standalone home-screen launch it is the one dialog that
does not look like Winnow. `ConfirmDialog` (`ui.tsx:261`) exists and is used by
the two other destructive surfaces (`TrashTab.tsx:363`, `UsersPanel.tsx:299`).
`PipelineAssetList.tsx:427` has the same shape. *Status: open.*

**C11 — Modals that close when you drag out of them.** Eight modals are still on
a bare `onClick={onClose}` backdrop — including `VolumesPanel.tsx:388`, whose
folder picker is a scrolling list. `useOverlayDismiss` exists precisely for this
(a drag started inside the dialog and released outside dispatches its click on
the overlay) and is already adopted by six others. *Status: open; already
recorded as a latent bug in `docs/memory/frontend.md`.*

**C12 — Rates you can only set by dragging, and never see confirmed.** Four
sliders run 0–3000 in steps of 50 with no numeric field
(`ControlPanel.tsx:13-16`), so a deliberate 1,200/h on a phone is a fight
against a 3px target. `ControlPanel.tsx:146-154` writes after a 350 ms debounce
with `.catch(() => {})` and no success state: nothing distinguishes "saved" from
"the PATCH was refused". These are the settings most likely to be adjusted from
a phone, mid-cull. **Fix**: a numeric input beside each slider, a small preset
set (Off · 250 · 1000 · Unlimited), a "Saved" tick that fades, and a surfaced
error. *Status: open.*

**C13 — Seven-column tables inside a sideways scroller, on a phone-first tool.**
Database renders 7 columns (`DatabasePanel.tsx:182`), Volumes 5
(`VolumesPanel.tsx:145`), both in `.vol-table-wrap { overflow-x: auto }`
(`globals.css:4352`). On the device where you are most likely to be checking
whether the scan finished, that is a table you drag left and right, with the
share meter off screen by default. **Fix**: below a breakpoint, collapse each
row into a stacked card — the pattern the duplicates page already uses for its
groups. The desktop table is unchanged. *Status: open.*

---

## 3. Coverage — is this the right set of settings?

Findings 1–13 ask whether the panes look like one app. This section asks whether
the things you can change are the things you would want to change.

Winnow has **99 knobs across four tiers**. Eleven are managed from a Settings
page — meaning a pane reads the value, changes it, and shows you what it
currently is.

| Tier | What it holds | Knobs | Managed from Settings |
|---|---|---|---|
| Environment (`src/lib/config.ts`) | paths, credentials, concurrency, models | 68 | 0 |
| `app_settings` (`src/lib/settings.ts`) | pause, hourly rates, geocoding, export pairing | 9 | 5 |
| Feature flags (`src/lib/features.ts`) | which sections the rail offers | 6 | 6 |
| `localStorage` (`winnow.*`) | per-device view preferences | 16 | 0 |

68 environment variables holding paths and credentials is *correct* — nobody
wants an S3 secret editable from a web form. The finding is that nothing
distinguishes the ones that are genuinely deployment from the ones that are
simply on the wrong tier, and that the app never shows any of them, even
read-only.

**D14 — There are four tiers and only three are admitted.** Sixteen
`localStorage` keys accumulated one page at a time (`winnow.theme`,
`winnow.grid.size`, `winnow.sessions.layout`, `winnow.pipeline.{view,sort,density}`,
`winnow.gear.{view,source}`, `winnow.viewer.info`, `winnow.dedup.scope`,
`winnow.relink.job`, and five separate remembered library sources). Every one is
a preference; none is visible from Settings, resettable, or carried to a second
device. `db/migrations/0032_users.sql` creates a `users` table with no
preferences beside it. **Fix**: name the tier — either accept it as "this
device" and give it one pane that lists and resets it, or promote the
account-level handful (theme, default library source) to a `user_preferences`
row. Invisible and per-device is the only option that cannot be explained to a
user. *Status: open.*

**D15 — The tiers answer "does it need a restart", not "whose decision is it".**
The documented rule is a fact about the runtime, not about the person. There are
three deciders: the **operator** (paths, credentials, pool sizes,
concurrencies), the **photographer** (what counts as a burst, who appears on
People, how coarse a place name is) and the **moment** (pause, rates). The
photographer's knobs are scattered across all four tiers, and two of identical
nature land on opposite sides: `geocodePrecisionM` (grouping that changes what
you see) is live in the database, while `ML_PERSON_MIN_FACES` (a threshold that
changes who appears on `/people`) needs a container restart. **Fix**: keep the
runtime rule — it is true and it matters — but let the *pane* follow the
decider. *Status: open; this is the one finding that changes what the others
should look like.*

**D16 — Three live settings have no writer anywhere in the UI.**
`PATCH /api/settings` accepts nine keys (`api/settings/route.ts:12-24`). The
Pipeline pane writes four, the pause button a fifth, the Exports toolbar a sixth
(`ExportsTab.tsx:47`, `exportIncludeJpeg` only). Nothing writes `geocodePerHour`
or `geocodePrecisionM`; `exportIncludeLiveVideo` is *read* as a default
(`ExportFilePicker.tsx:84`) and never written. All three are reachable only by
`curl`. `geocodePrecisionM` is the sharpest case: it is the grid step that snaps
coordinates into a shared cell, and those cells **are** the Heatmap's bins — the
Heatmap panel states out loud that its bins do not refine, while the knob that
would change their size exists and has no control. **Fix**: a Geocoding group on
the Operations pane (rate + cell size in metres, with its effect on place names
named) and a Live Photo companion toggle beside the JPEG one. Three controls, no
schema change, no new endpoint. *Status: open.*

**D17 — One pane, three kinds of thing, no grouping.** `ControlPanel.tsx` stacks
counters at `:162` (*what is true*), pause + four sliders at `:227` (*what
should happen*) and two one-shot backfills at `:327` and `:346` (*do this now,
once*) in one flat column. Three different contracts — observation, persistent
policy, an action with a side effect — in the same visual register. **Fix**:
three groups with their own headings: State, Policy, Maintenance. A maintenance
action also states what it will do and reports what it did; it is the only one
of the three that cannot be undone by moving a slider back. *Status: open.*

**D18 — Nothing shows the instance's configuration, even read-only.** 68
variables decide whether ML runs and against which models, whether Immich push
is configured, which geocoder is called, where exports land. The app surfaces
two derived booleans (`stats.mlEnabled`, `stats.clipEnabled`) and the pgvector
row on the Database page. "Is Immich push configured?" is unanswerable from the
UI. This is the same problem `docs/memory/configuration.md` records from the
other side — eight documented variables missing from the Optiplex compose
anchor, failing silently — and a read-only page of *effective* values is exactly
what surfaces that drift. **Fix**: fold it into A3's Overview pane, grouped by
subsystem, secrets redacted to a present/absent badge. The values are already
parsed and validated in one place, so this is the cheapest fix in the document
and the one that makes the other 68 knobs legible without making them editable.
*Status: open.*

---

## 4. The options that are missing

Ordered by how often the absence would bite someone running this on a home NAS.
E19 is a missing *concept*; the rest are fields.

**E19 — Quiet hours: a schedule, not just a cap.** The only pacing Winnow has is
a flat ceiling in photos per hour. The real constraint on a box that shares a
house is temporal — don't scan while I'm editing, don't saturate the uplink in
the evening, go as fast as you like at 3 a.m. A flat 1,200/h cannot express any
of that: you either throttle permanently or accept the contention. Nothing in
`lib/settings.ts`, `lib/rate.ts` or `worker.ts` carries a time window; the token
bucket is per-hour and unconditional. **This is the most valuable thing the
settings do not have, and the rate sliders are the wrong shape for it.**

**E20 — A retention policy for the trash.** Deletes are soft by design and that
is right, but nothing ever empties the trash: purge is a manual action behind
`PURGE_ENABLED`, with no interval and no age threshold. The expected setting is
one line — purge trashed items older than N days, off by default.
`ARCHITECTURE-REVIEW.md` §4 already lists a retention janitor as P1.

**E21 — The import filing template.** Imported originals are filed as
`{incoming}/{device}/{YYYY}/{YYYY-MM-DD}/{file}`, hardcoded at
`src/lib/import.ts:76`. This is the one place Winnow *creates* structure inside
the originals' world rather than reading it, and the person who owns that
archive — very likely with a folder convention already — cannot change it. Of
every gap here this is the one most likely to stop someone using the import path
at all.

**E22 — Geocoding rate and cell size.** Already in the database, already read by
the worker, no control. See D16.

**E23 — Any notification at all.** No mail, no webhook, no push — zero matches
across `src/lib` and `src/app/api`. Nothing tells you an import finished, that
the scan has been paused for a week, or that five thousand files failed. On a box
reached through a tunnel that is the difference between checking the page and
not having to. The service worker already exists, so web push is not a new
dependency.

**E24 — Preferences that follow the account.** Sixteen device-local keys, a
`users` table with nothing beside it. Pick a theme on the desktop and the phone
stays on the other one, permanently, with no way to see or reset either. See
D14.

**E25 — The taste thresholds, out of the environment.**
`ML_PERSON_MIN_FACES` (who is shown on People), `ML_PERSON_MIN_SIMILARITY` (how
readily two faces merge), `BURST_GAP_SECONDS` and `BURST_MIN_FRAMES` (what counts
as a burst). All four change what you see rather than how the box runs, all four
are re-derivable, all four need a container restart. The clearest instance of
D15, and the one migration this review actually asks for.

**E26 — The Live Photo companion default.** The JPEG companion has a persisted
default and a per-export tick; the Live Photo motion has only the tick. Its
stored default exists, is read, and can never be set. The smallest finding here
and the easiest fix.

---

## 5. Roadmap

Three passes, each shippable alone, each ending green on the gate this repo
actually runs (`typecheck` + `migrate` + `build`). **No migration is needed for
any of it.**

1. **The shared shapes** — B5, B6, B7, B8. Add `.pane-head`, `.section-head`
   and `.meter` to `globals.css`, then apply them across the six panes and
   delete the inline styles, the five wait states and the emoji. Pure
   presentation: no route moves, no endpoint changes, ~12 files. Largest visible
   gain for the lowest risk, so it goes first.
2. **The dialogs and the controls** — C10, C11, C12, B9. `ConfirmDialog` for
   volume removal, `useOverlayDismiss` on the remaining modals, `OptionPicker`
   for the volume type, numeric fields and a saved-state on the rate sliders.
   Behaviour rather than layout, so it lands after step 1 without conflicting.
   Closes one latent data-loss bug (C11), ~8 files.
3. **The shape** — A1–A4. The rail, the breadcrumb, the Overview pane, Users and
   Account coming home. The only step that moves routes, and the one worth
   deciding before it is built. D18's read-only view of the environment belongs
   in the same Overview pane, so build them together.
4. **The coverage gaps** — D16 and E22/E26 are three controls over settings that
   already exist: an afternoon, no migration. E25 needs one migration to move
   four thresholds into `app_settings`. E19, E20, E21 and E23 are features
   rather than settings work, and each deserves its own brief.

**Step 0, before any of them: settle D15.** Whether the panes follow the runtime
or the decider is the answer the rail of A1 is the shape of. It is a decision,
not a commit, and it is the maintainer's.

---

## 6. What this review deliberately does not touch

- **The pipeline console's own density.** `PipelineAssetList.tsx` (998 LOC) and
  `DuplicatesFailures.tsx` (628) are large, but `docs/memory/frontend.md`
  already records that the big UI files are acknowledged and that a wholesale
  split is a task of its own. Steps 1–3 above touch their chrome, not their
  guts.
- **Anything requiring a new endpoint**, except the Overview pane of A3 — and
  even there the figures already exist; only their composition is new.
- **The palette.** Every finding is satisfied by tokens and classes the app
  already ships.
