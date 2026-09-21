# Project memory — decisions, reasons, traps

Long-term memory of this repo, read at the start of **every** agent session (imported by `CLAUDE.md`). It holds what the code and `git log` cannot tell you: the choices made and their reasons, what was tried and rejected, the traps that cost time, how the maintainer likes to work.

This file is the **always-loaded index**. The detail lives in `docs/memory/<topic>.md`, one file per area, loaded **on demand**: read the topic file(s) matching the area you are about to touch **before** acting (table at the bottom). Do not `@import` them into `CLAUDE.md` — the split exists to keep the per-session prompt small.

## How to maintain (mandatory — CLAUDE.md rule 2)

- **When**: at the end of every task, before its commit, in the same commit. Writing is the **default**; only skip if there is truly nothing a future agent could use, and say so explicitly in the final message.
- **What**: a design/product decision, a non-obvious technical choice, an explicit rejection ("the maintainer did not want X because Y"), a trap (browser, tooling, framework, hosting) and its remedy, a working preference. Not implementation detail readable in the diff, not what `git log` already says, not history ("this was fixed on…") — once a fix is committed, keep only the rule it taught.
- **Where**: the matching `docs/memory/<topic>.md`; a new file only when no topic fits (kebab-case name, add it to the table below with a "read when"). Cross-cutting rules, working style, decisions-at-a-glance and open items stay in this index.
- **How**: search first and **update** the existing entry rather than adding a near-duplicate; delete what became false. One entry = one short paragraph: *decision → why → how to apply*, dated `YYYY-MM-DD` on first write and on each revision. Say the same thing **once** — cross-reference other files by name instead of repeating.
- **Language**: **English**, dense, factual. No session narration.
- Budget: keep this index under ~200 lines and each topic file under ~150; if one outgrows that, split it.

## Working with Steeve Pommier

<!-- Fill in as you learn: how they validate work, how they phrase requests,
     what they want when an audit finds problems, what annoys them. -->

- 2026-08-20 — Roughly half this history is authored by Claude and merged through numbered PRs (`#212`…`#225`), the other half by the maintainer directly. Agent work arrives as a branch + PR whose title reads like the rest of the log — not as commits pushed to `main`.
- 2026-08-20 — Documentation is a deliverable here, not an afterthought: a 1000-line `README.md`, a `CONTRIBUTING.md` that names the CI gate, a `db/migrations/README.md` that argues its own rules and records every past collision, and an `ARCHITECTURE-REVIEW.md` that grades the codebase and names its own weaknesses. Match that register — explain the *why* and the trade-off, and say plainly what is fragile.
- 2026-08-20 — The code comments carry the reasoning, including the uncomfortable kind ("this API is unversioned", "this is the one sanctioned exception to rule 2"). A diff that deletes a *why* comment reads as a regression.
- 2026-09-19 — **A repair the maintainer has to SSH into the Optiplex for does not exist.** Winnow runs on a box he does not sit in front of, so any retroactive pass — a backfill, a re-read, a re-attribution — ships as a button in the admin UI that reports what it did, and the `npm run *-backfill` script is the *counterpart*, never the interface. `srt-backfill` and `ml-backfill` are the two shapes to copy: inline when the work is DB-only or reads tiny files (the route returns a summary), enqueue-only when it touches originals (the jobs drain through an existing queue at the rate its slider already sets, and the tab's count badge is the progress bar). Proposing a fix whose delivery is a shell command misses the point of the request.
- 2026-08-20 — When an audit finds problems, the established form is the one `ARCHITECTURE-REVIEW.md` uses: numbered findings, an explicit status (**Fixed** / roadmap tier), and the fixes shipped alongside the report. Findings without that structure will feel unfinished.

## Direction in five lines

- Winnow is one photographer's ingest → cull → export pipeline over a home NAS, not a product: it targets the maintainer's real library (Sony A7C II / DJI / iPhone / Ray-Ban Meta) on a single Optiplex box.
- The guiding principle, stated in `README.md` and enforced throughout: **the originals are touched once**. Everything afterwards reads Postgres and the derivative cache; deletes are soft.
- Culling happens on lightweight proxies, never on RAWs. Immich keeps the browsing/phone job; Winnow pushes copies to it rather than absorbing it.
- Scope grows by the verbs the workflow needs (sift, bursts, faces, places, gear, people) — each lands as a page + an API route + usually a migration.
- Scale target, per `docs/ARCHITECTURE-REVIEW.md`: comfortable at ~100k assets, with the sharding/ANN/retention decisions deliberately deferred to 500k–1M.

## Decisions at a glance (details in the topic files)

- Originals are read-only and read once; deletes are soft → `docs/memory/architecture.md`
- Derivatives sit on disk behind an S3-shaped driver, so MinIO is one env flip away → `docs/memory/architecture.md`
- Dedup is a partial hash arbitrated by a full-content compare, every decision logged → `docs/memory/architecture.md`
- Only Incoming copies are ever deletable, so "no RAW in the Gallery" is reported, not fixed, by dedup → `docs/memory/architecture.md`
- Removing an asset's bytes must release its `content_hash`, or the surviving file is unindexable forever → `docs/memory/architecture.md`
- Logic lives in `src/lib/`; worker, API routes and CLI scripts are thin wrappers → `docs/memory/architecture.md`
- One worker process, nine BullMQ queues, chained manually rather than by BullMQ flows → `docs/memory/pipeline.md`
- Worker memory hygiene (jemalloc, out-of-process HEIF decode, `sharp.cache(false)`) is load-bearing → `docs/memory/pipeline.md`
- ML is a remote HTTP call to Immich's internal `/predict`; Winnow embeds no model → `docs/memory/pipeline.md`
- Migrations are append-only and uniquely numbered; a rename costs a `RENUMBERED` shim → `docs/memory/database.md`
- All configuration passes one Zod schema that fail-fasts at boot → `docs/memory/configuration.md`
- Rates live in the database (tunable live), concurrency in the environment (needs a restart) → `docs/memory/configuration.md`
- Deploy is push-to-`main` → ghcr image → Watchtower pull on the Optiplex, behind Traefik + Cloudflare Tunnel → `docs/memory/deployment.md`
- Identity lives in the app (`src/proxy.ts` + `src/lib/authz.ts`), not in the reverse proxy → `docs/memory/auth.md`
- Atelier (the editing app, a sibling subdomain) calls the API cross-origin with the session cookie: same-site, so no token — just an exact-origin CORS allowlist answered before the session check, plus `GET /api/capabilities` → `docs/memory/auth.md`
- Every user-facing string is in English (en-GB dates), whatever language the session is held in → `docs/memory/frontend.md`
- Styling is a token-based "Paper" system of semantic classes in `globals.css`, not utilities in JSX → `docs/memory/frontend.md`
- Every DB-backed route opts out of static rendering with `force-dynamic` → `docs/memory/frontend.md`
- The dedup triage page pages server-side on its own endpoint, off the shared failures poll → `docs/memory/frontend.md`
- /gear carries no illustrations any more: eight layouts over one derived `Kit`, Stack the default, the choice remembered → `docs/memory/frontend.md`
- One shared picker for "one of N": segments up to four options, a menu above — the form follows the count, never the viewport → `docs/memory/frontend.md`
- The Incoming/Gallery/All picker is a SECTION selector: it rides `PageHeader`'s `tabs` slot beside the title on all five pages that carry it, never the toolbar band → `docs/memory/frontend.md`
- Any element Leaflet initializes onto needs `isolation: isolate`, or its panes (z-index 200–700) escape and paint over the rest of the app — `.map-wrap`, `.picker-map`, `.heat-map` all needed it → `docs/memory/frontend.md`
- An outage is reported as a status pill, never a takeover; the full-page offline screen is only for a cold navigation → `docs/memory/frontend.md`
- A home-screen icon comes from `apple-touch-icon` alone on iOS (Chrome for iOS is WebKit too), never from an SVG favicon: the committed PNG set here is the portfolio's reference implementation, and `display` is the one field each repo decides for itself → `docs/memory/frontend.md`, `COMMON-PROJECT-SPEC.md` in `second-brain`
- The Timeline derives chapters per request (one SQL row per run, JS absorption); edits are stored as corrections (named spans, forced breaks — migration 0040), never as chapters → `docs/memory/frontend.md`, `docs/memory/database.md`
- A deduced location never enters an original's EXIF: the Timeline's guess is display-only, a folder suggestion accepted in bulk persists as `gps_source='inferred'` on the row alone, and only a hand-placed `'manual'` pin is written back; the indexer guard that keeps `'inferred'` across a re-index is load-bearing → `docs/memory/architecture.md`, `docs/UNPLACED.md`
- A body a file never named is voted on, never guessed: five weighted signals propose, a human applies per FOLDER, `device_source` + the indexer guard keep it → `docs/memory/pipeline.md`
- A backlog a human clears in bulk is a list of folder cards — one verb, a facet row, the rules printed: Unplaced and Devices share the shape and its classes → `docs/memory/frontend.md`
- The whole verification gate is `typecheck` + `migrate` + `build`; no linter, no tests → `docs/memory/testing-and-ci.md`
- Every section but the Library is behind a feature flag stored in `app_settings`; off means hidden AND 404, pages and own API routes alike → `docs/memory/configuration.md`, `docs/memory/frontend.md`
- The Heatmap reads the library as a distribution, four ways over ONE measure and ONE ramp; backlog is the default and the one measure uniquely Winnow's → `docs/memory/frontend.md`
- An aggregate over the WHOLE library must run `SET LOCAL jit = off` and be one scan: `collapseGroups` puts the plan over `jit_above_cost` and the compile costs 40× the query → `docs/memory/database.md`
- `/settings` has a review of record (`docs/SETTINGS-UI.md`, 26 findings): the section's problem is that it reaches for none of the shared components `ui.tsx` already exports → `docs/memory/frontend.md`
- 99 knobs across FOUR tiers (68 env · 9 `app_settings` · 6 flags · 16 `localStorage`), 13 managed from a Settings page; a key with a default and a reader but no writer is not shipped → `docs/memory/configuration.md`
- `docs/UI-REVIEW.md` (2026-09-13) is the design backlog: two header bands per section, one primary action per card, a count drawn once, vermillion for brand/rail/focus only, three control heights, six type steps → `docs/memory/frontend.md`
- The environment tier is readable at `/settings/instance`, each row saying `env` or `default`; a page whose content IS `process.env` must be `force-dynamic` or CI's environment gets baked into the image → `docs/memory/frontend.md`
- `backdrop-filter` never rides on a tile the viewport multiplies: measured, the grid badges' blur cost 73 % of scroll frames, and the 400 px thumb in a 110 px cell costs almost nothing → `docs/memory/frontend.md`

- A session that changes code reports this project's state to `PROJETS.md`, at the root of the private `second-brain` repo: the register is that file, never Claude's memory and never `git log` → CLAUDE.md rule 3

## Open items (dated; remove when done)

- 2026-09-20 — **Device attribution shipped; the embedded re-read did not.** Media whose file names no camera (DJI MP4s above all) are now triaged on Settings › Pipeline › Devices, **one card per folder** (the flat list it shipped with lasted one session), and `device_source` + an indexer guard keep the result through re-indexing (`docs/memory/pipeline.md`, migration 0043). What is still open is the one source the vote cannot replace: the `Model`/`SerialNumber` in the MP4's `djmd` track, reachable only under exiftool's `-ee`, which alone could tell two identical bodies apart. It wants an enqueue-only pass over the index queue and a measurement on a real clip first — a 469 MB file on a spinning HDD is not free. Nothing else should be built on `device` being EXIF-only: it now has four provenances.
- 2026-09-14 — **The Settings review is written and nothing in it is fixed**: `docs/SETTINGS-UI.md`, 26 findings, all *open*. Its §5 orders the work (presentation pass first, routes last) but **step 0 is a decision, not a commit**: D15 asks whether a settings pane should follow the runtime (live vs restart, today's rule) or the decider (operator / photographer / moment), and the answer is the shape of the rail every other finding assumes. Maintainer's call. **D16/E22/E26 and D18 are Fixed** — the geocoding rate + cell size have a control group on Settings › Pipeline, the Live Photo companion a toggle in the Exports toolbar, and `/settings/instance` now prints the environment tier read-only with each row's source (`env` / `default`), which is what makes the compose drift below findable. B6's `.pane-head`/`.section-head` exist too, written by that page. Four gaps are features rather than settings work and each wants its own brief: quiet hours (E19, the one missing *concept* — pacing is a flat per-hour cap with no notion of a time window), a trash retention policy (E20), a configurable import filing template (E21 — hardcoded at `src/lib/import.ts:76`, and the one place Winnow creates structure in the originals' world), and any notification at all (E23 — there is none, of any kind).
- 2026-09-15 — **The UI review's P0 tier shipped and P1 is under way (PR #248).** `PageHeader`, the `.page-tools` band, the session card and the session page landed 2026-09-15 (S1, S3, S4, H1–H3, H5, M3); what remains of P1: the Timeline's chapter dates (H1), colour semantics (H4), control heights (A3/T2), the phone bar (M5), the viewer's info sheet (M4). P2 (five tab families, four chip families, 35 font sizes) is untouched. `docs/UI-REVIEW.md` is the register; the rules in `docs/memory/frontend.md` apply to any new UI meanwhile.
- 2026-09-07 — **The Heatmap shipped, off by default**, with all four readings the maintainer asked for behind one segmented control (`docs/HEATMAP.md` is now a record, not a proposal). What is still open there: the bins do not refine on zoom (they are the geocoding cells; a `round(lat/step)` grid over `assets_gps_coords_idx` is the next step), and three of the brief's five questions were answered by building rather than by decision — the name ("Heatmap"), the default measure (backlog) and keeper rate shipping in v1 with its floor stated. The fifth is answered (2026-09-20): `geo_state=todo` is that filter — the Position chips in the gallery panel — and `docs/UNPLACED.md` is the screen it grew into.
- 2026-09-07 — **The Timeline ships OFF** (feature flag, `src/lib/features.ts`): its chapters are re-derived per request, the cut rules and the behaviour at library scale still owe a rework, and Atelier stopped reading them for exactly that reason (`shared/sources/winnow/features.ts` there carries the argument). What is open is the rework itself, not the flag. Until it lands, do not build anything new on `/api/assets/timeline`, and remember the route now 404s by default — a client asking it will not get an empty answer, it will get nothing.
- 2026-08-20 (revised 2026-09-20) — **Two duplicate migration prefixes are still on `main`**, contradicting rule 1 of `db/migrations/README.md`: `0010_gps_coords.sql` / `0010_search_text.sql` and `0013_asset_groups.sql` / `0013_clean_object_placeholders.sql`. They apply today in an accidental lexicographic order. Renumbering them means extending `RENUMBERED` in `src/lib/migrate.ts` and touches every already-migrated database — maintainer's call, and older/riskier than the third collision was. The **`0042` collision is fixed**: `0042_device_attribution` (#253, merged second) became `0043`, with its shim entry and a "History" row, the day it appeared — which is the cheap moment to do it and the precedent to follow for the next one. **Next free number is `0045`** (`0044_app_files` landed with #259).
- 2026-08-20 — The P1 list in `docs/ARCHITECTURE-REVIEW.md` §4 is the standing backlog (disk-space preflight, streamed video proxies, retention janitor, the `asset_faces.embedding` decision, job cancel, fail-closed `getSettings()`, compose env drift). Check it before proposing pipeline work; nothing in this memory supersedes it.
- 2026-09-02 — **The purge worker still leaves `content_hash` set on the rows it purges** (`src/lib/purge.ts` step 3), while `reclaimTrashedAsset` in `src/lib/duplicates.ts` releases it and documents why a purged row holding a hash makes the surviving file unindexable forever. The dedup sweep now repairs those rows after the fact ("Clear resolved"), so nothing is stuck — but the two paths disagree, and fixing the worker would stop the state from being created at all. It changes purge semantics for every already-purged row, so it is the maintainer's call.
- 2026-08-20 — No test suite and no test runner. Several pure functions are explicitly shaped for testing (review §3.5) but nothing runs them, so every refactor rides on `tsc` alone. Adding the first test also means choosing a runner and adding a CI job — a decision, not a chore.
- 2026-09-02 — **Moving an indexed original to another folder deadlocks the pipeline**: the file is dropped as an unverifiable duplicate while its row is flagged missing + auto-trashed, and no rescan ever repairs it. Nothing *detects* a move at scan time yet — `npm run relink-moved` repairs it after the fact (purged rows included; purging does not release `content_hash`). `docs/memory/pipeline.md` carries the mechanism, the traps and the fix of record: store `(st.dev, st.ino)` and treat an ENOENT-pathed collision as a move, so the repair stops being needed. Maintainer's call on sequencing.
- 2026-08-20 — `docker-compose-optiplex.yml`'s `x-winnow-env` anchor is missing a documented set of variables (`ML_CLIP_*`, `IMMICH_*`, `BURST_*`, `SHARP_CONCURRENCY`, `PURGE_*`, `HEIC_DECODE_TIMEOUT_MS`, `BROWSE_ROOTS`, `FINALS_DIRS`). Defaults keep production running, so it fails silently: those knobs simply cannot be tuned on the Optiplex. **`/settings/instance` on the Optiplex now names them** — each shows `default` — so confirming the list is a page visit rather than a compose diff; fixing the anchor is still open. See `docs/memory/configuration.md`.

## Topic files — read before touching the area

| File | Read when you touch… |
| --- | --- |
| `docs/memory/architecture.md` | the overall shape: originals policy, storage driver, dedup, the app/worker split |
| `docs/memory/pipeline.md` | the worker, any queue, scanning, derivatives, ML, geocoding, rate limits, memory behaviour |
| `docs/memory/database.md` | `db/migrations/`, the schema, indexes, `src/lib/db.ts`, anything SQL |
| `docs/memory/configuration.md` | env vars, `src/lib/config.ts`, `.env.dist`, the compose env anchors, live settings |
| `docs/memory/deployment.md` | the `Dockerfile`, compose files, CI workflows, the Optiplex / Traefik / Cloudflare path |
| `docs/memory/frontend.md` | `src/app/**`, pages, styling, the viewer/grid interactions, the PWA |
| `docs/memory/auth.md` | login, invites, sessions, roles, `src/proxy.ts`, `src/lib/{auth,authz}.ts` |
| `docs/memory/testing-and-ci.md` | deciding a change is done, `.github/workflows/`, adding tests |

Not a memory file, but read it before proposing work on the Calendar, the Map
or a new way of reading the library at large:

- **`docs/HEATMAP.md`** — the brief for `/heatmap`, now a **record**: the four
  readings shipped 2026-09-07. §1–§5 carry the reasoning (why the crossing, why
  the measure list, why the bins were free), §6 the placement argument that
  will come up again for the next rail entry, §9 how the five open questions
  were settled, and §10 the four claims the build proved wrong — including the
  JIT finding and why the calendar needed a Day/Week toggle.
- **`docs/UI-REVIEW.md`** — the UI review of 2026-09-13, in the
  `ARCHITECTURE-REVIEW.md` form: §1 what to preserve, §2 thirty-two numbered
  findings (structure, hierarchy, phone, component drift, type/tokens,
  accessibility, polish) with measurements, §3 the five moves of the rework,
  §4 the P0/P1/P2 roadmap, §5 how the screens were produced and what they did
  not cover. Read it before touching a header, a card, a toolbar or a colour.
- **`docs/UNPLACED.md`** — the brief, now a **record** (shipped 2026-09-20),
  for "Unplaced", bulk geotagging of the 84 452 position-less Incoming media
  by folder group: §2 the census that justifies it (~400 gestures close 99 %),
  §4 the taken decisions (Incoming only, a new `gps_source='inferred'` that is
  never written into the original's EXIF, temporal grouping only, no fourth
  path past the recap), §5 the `by=day` API contract, §6 the cross-repo
  invariant Atelier's trip legs depend on, §7–§8 the screen and the printed
  rules, §9 what the first real run proved wrong (a container folder bridges
  any temporal chain: 360 folders became one card, hence `span_max_h` and
  the parts cut at the same 2 h silence). Read it before touching
  `gps_source`, the geotag flow, `/api/assets/geo`,
  `/library/incoming/unplaced` or any time-clustering over the library.
