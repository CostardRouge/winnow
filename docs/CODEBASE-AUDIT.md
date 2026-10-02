# Winnow — Codebase audit (2026-10-02)

*A whole-codebase audit at ~75k lines (477 tracked files, 47 migration files, 111
API routes, 43 pages, 9 queues), in the form `ARCHITECTURE-REVIEW.md` set:
an inventory, numbered findings with an explicit status, a prioritised plan,
and the first batch of fixes shipped alongside. Where this document and
`ARCHITECTURE-REVIEW.md` overlap, the review's IDs (R1–R8, D1–D10, C1–C9) are
cited rather than restated; everything here is new or newly confirmed.*

**How it was produced, and what each claim rests on.** Every finding carries
an evidence tag:

- `reproduced` — run against this tree: a local Postgres 16 + Redis, the
  production build served by `next start`, a synthetic 100k-asset library
  (1,000 sessions, 33k ratings) for timings and query plans, headless
  Chromium for browser behaviour, and standalone Node scripts for runtime
  limits. The exact command is in the finding's *Verification*.
- `read` — the code path was read end to end in this audit.
- `sweep` — reported with file:line by one of five parallel read-only sweeps
  (security, database, frontend/UX/a11y, code health, operability) and
  spot-checked, but not re-run. Two sweep claims were **corrected** by
  reproduction: an idle Postgres error does *not* crash the app (BE-25), and
  the facets/stats endpoints are *not* slow at 100k (FE-02 has the numbers).

What this audit could **not** see: production data, `pg_stat_*` counters,
the Optiplex's Watchtower flags, Traefik's forwarded-headers trust, the
Cloudflare plan, and real NAS latency. Findings that depend on them say so.

Statuses: **Fixed (batch 1)** — shipped in the same pull request as this
document, one commit per finding; **Batch N** — the plan in §3; **Decision** —
needs the maintainer (§3.4); **Won't** — §3.3.

---

## 1. Inventory (phase 0)

### 1.1 Directory map

| Area | Files / lines | Responsibility |
|---|---|---|
| `src/proxy.ts` | 1 / 170 | The request guard (Next 16 middleware, Node runtime): cookie or `Bearer wnw_` token → role check (`lib/authz.ts`) → identity headers; CORS preflight before auth. |
| `src/app/api/**` | 111 / 8.2k | Route handlers. 75 of them carry inline SQL (172 statements, ~870 SQL lines — `api/sessions`, `api/facets`, `api/people/[id]` lead). |
| `src/app/**` (UI) | 171 / 44k | 43 pages; client components; `globals.css` (8.3k lines, the "Paper" token system); `ui.tsx` shared primitives. |
| `src/lib/**` | 73 / 17.2k | Domain + infrastructure: indexer, derivatives, ML, geocode, import/export, purge, dedup, relink, integrity, people, timeline, heat, auth/authz/cors, config, db, queue, storage driver (disk/S3). Also three client-side helpers (`assetActions.ts`, `fetchJson.ts`, `cn.ts`). |
| `src/worker.ts` | 1 / 370 | One process, nine BullMQ workers, a 60 s periodic-rescan tick, the inbox watcher, SIGTERM/SIGINT shutdown. |
| `src/scripts/` | 9 / 539 | CLI twins of UI repairs (`scan`, `*-backfill`, `relink-moved`), the worker healthcheck, the out-of-process HEIF decoder. |
| `db/migrations/` | 47 SQL + README / 1.75k | Append-only SQL, `0001`–`0045` (two duplicate prefixes, `0010`/`0013`, known). |
| `scripts/` | 3 | `pg-backup.sh`, `pg-restore.sh`, `gen-icons.ts`. |
| `docs/` | 25 | Reviews of record, briefs, `memory/` (agent memory topic files). |
| Compose / Docker | 3 + 1 | `docker-compose.yml` (local prod-ish), `.dev.yml` overlay, `docker-compose-optiplex.yml` (production: Postgres+pgvector, Redis AOF, backup sidecar, migrate one-shot, app, worker). |

### 1.2 Entry points

- **Pages**: 43 (`/library/*`, `/gallery`, `/sessions/[id]`, `/sift/*`, `/people/*`, `/gear`, `/heatmap`, `/timeline`, `/search`, `/settings/*` incl. 13 pipeline pages, `/users`, `/users/tokens`, `/login`, `/invite/[token]`).
- **API**: 111 route files, 136 handlers — 69 GET, 45 POST, 9 PATCH, 2 PUT, 11 DELETE. Public without a session: `/api/auth/{login,setup,invite}`, `/api/health`, and — because the proxy matcher excludes `/_next/` — Next's own `/_next/image` optimizer (SEC-02).
- **Background**: the nine queues of `ARCHITECTURE-REVIEW.md` §1; the worker's 60 s tick (`worker.ts:303`) re-enqueues watched roots every `rescanMinutes`; the chokidar inbox watcher (`lib/watcher.ts`); `bootstrapRoots()` at worker start.
- **Cron / scheduled**: none in the app. The `backup` compose sidecar dumps Postgres on `BACKUP_INTERVAL`; Watchtower polls GHCR.
- **Webhooks**: none received. `docker-build.yml` *sends* one (Watchtower's HTTP API, optional).

### 1.3 Data model (from the live catalog after `npm run migrate`)

29 tables (30 with pgvector). Curation state — the irreplaceable half — is
`ratings`, `asset_tags`, `asset_faces.person_id`/`people`, `exports`,
`timeline_*`. The FK chain that matters most: **`roots` → `sessions` →
`assets` → `ratings`/`asset_tags`/`asset_faces`/`asset_sidecars`/`exports`,
every link `ON DELETE CASCADE`** (BE-09).

| Table | Key | Notes |
|---|---|---|
| `roots` | id; `path` UNIQUE | `kind` CHECK (source, finals, inbox, export), `watch` |
| `sessions` | id; `source_path` UNIQUE | `root_id` → roots CASCADE (unindexed; small table) |
| `assets` | id; `abs_path` UNIQUE; partial UNIQUE `content_hash` | 73 columns, **47 indexes** (3 GIN trigram, 13 partial, ~26 single-column); FKs to sessions (CASCADE), asset_groups / bursts / places / self (SET NULL); 9 CHECK-ed status columns |
| `ratings` | PK asset_id → assets CASCADE | `verdict` CHECK (pick, reject, skip, unrated), `star` 0–5, `rated_by` → users SET NULL |
| `tags`, `asset_tags` | tags.name UNIQUE; PK (asset_id, tag_id) | both FKs CASCADE |
| `asset_faces`, `people` | ids | face → asset CASCADE, → person SET NULL; `people.cover_face_id` → faces SET NULL (unindexed, BE-18) |
| `asset_groups`, `bursts` | ids | per session, CASCADE |
| `asset_sidecars` | id; `abs_path` UNIQUE | → assets CASCADE |
| `places` | id; UNIQUE (cell_lat, cell_lon, precision_m) | geocode cell cache |
| `export_jobs`, `exports` | ids | lineage `exports.source_asset_id` → assets CASCADE; no uniqueness on lineage (BE-07) |
| `import_batches`, `purge_jobs`, `purge_log`, `scan_failures`, `duplicate_hits` | | job/audit tables; `duplicate_hits.content_hash` unindexed (BE-18) |
| `users`, `auth_sessions`, `user_invites`, `access_tokens` | | only SHA-256 of tokens stored; sessions/invites/tokens CASCADE with the user |
| `app_documents`, `app_files` | (app, id[, user_id]) | per-user client-app buckets |
| `timeline_chapters`, `timeline_breaks` | | human corrections only |
| `app_settings` | key | jsonb: rates, pause, feature flags |
| `asset_clip` | asset_id | only with pgvector (`0030` skips it otherwise) |

### 1.4 External dependencies, integrations, secrets

- **Services**: Postgres 16 (+pgvector), Redis 7 (BullMQ, rate buckets, scan locks), `immich-machine-learning` (`POST /predict`, internal API), Immich server (public REST, export target, off by default), Nominatim (reverse geocode + place search), optional MinIO/S3, map tiles (client-side, `NEXT_PUBLIC_MAP_TILE_*`, inlined at build).
- **Binaries**: exiftool (perl), ffmpeg (+VAAPI on amd64), `pg_dump` 16, libheif via `heic-convert` (out of process), sharp/libvips.
- **Secrets**: read only from the environment through `src/lib/config.ts` (`DATABASE_URL`, `REDIS_URL`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `IMMICH_API_KEY`); production values come from compose's `x-winnow-env` + the host `.env` (gitignored). CI secrets: `DEPLOY_WEBHOOK_URL`/`_TOKEN`. No secret is committed (`.env.dist` holds documented loopback placeholders); `/settings/instance` redacts credentials. The only `process.env` reads outside `config.ts` are `NODE_ENV`, `WINNOW_PROCESS`, `NEXT_PUBLIC_*` and `instance.ts`'s source check — all legitimate.
- **Dependencies**: 18 runtime, 9 dev; lockfile v3 in sync with `package.json`. `npm audit --omit=dev` on this tree: **1 critical, 2 high** (SEC-02). `geist` is listed and imported nowhere (FE-10).

### 1.5 Commands that actually work (run in this audit)

| Command | Result |
|---|---|
| `npm ci` | ✓ ~1 min |
| `npm run typecheck` | ✓ 2.2 s (`tsc --noEmit`, `strict: true`) |
| `npm run migrate` | ✓ all 45 against Postgres 16 (without pgvector here, so `0030` takes its skip branch — CI's pgvector image covers the other) |
| `npm run build` | ✓ 16 s; one Turbopack warning (whole-project NFT trace from `lib/export.ts` — harmless without `output: standalone`) |
| `npm start` / `npm run worker` | ✓ app served and exercised; worker not run end-to-end (no NAS) |
| lint | **none exists** (no ESLint config; 45 dead `eslint-disable` comments) |
| tests | **none existed** — batch 1 adds `npm test` (node:test via the `tsx` already in dependencies, no new package) |
| deploy | push to `main` → `docker-build.yml` → GHCR → Watchtower; not runnable here |

### 1.6 Dead and duplicated code

- **Dead files: none** — an import graph over all 366 `src` files (Next conventions, worker, migrate and scripts as entry points) reaches every file.
- **Unreferenced exports**: `roles.ts roleForKind`, `heatScale.ts fold`, `failures.ts resolveScanFailure` (which should be called — BE-24), seven `types.ts` interfaces, `useFailures.ts FailuresState`; five unused locals/params (`tsc --noUnusedLocals`).
- **Duplication clusters** (detail in §2.B): `contentDisposition()` ×7, `numbered()` ×4, stream-a-file response ×5, route-id parsing ×38 (10 unchecked), `safeParse(await req.json())` ×42, session-stats SQL ×2 (already drifted), person-detail SQL ×2, `fmtDate`/`formatBytes`/`formatWhen` ×3 each, modal shells ×20, root-kind SQL lists ×12, path-under-root checks ×9, `walk()` ×2 and `exists()` ×3 (known, review §3.5).

### 1.7 Could not determine

1. Whether Watchtower on the Optiplex runs with `--include-stopped --revive-stopped` (decides SCL-01).
2. Whether Traefik trusts cloudflared's `X-Forwarded-For` (decides which half of SEC-05 production has).
3. Whether Traefik's Docker provider stops routing to an *unhealthy* container in this setup (SCL-03).
4. `pg_stat_user_indexes.idx_scan` on the real library (decides which of the 47 asset indexes can go, BE-14).
5. Which other apps share `steeve.website` and how much they are trusted (sizes SEC-03).
6. The Cloudflare plan's request-body cap (100 MB on Free/Pro), which bounds BE-04's fix.
7. Whether `captured_at` in the DB is wall-clock-as-UTC or true UTC — `import.ts planDestination` files by UTC day, which is right only for the former.

---

## 2. Findings (phase 1)

Every finding uses the same fields, in this order: **ID · Severity ·
Location · Problem · Impact · Fix · Effort · Risk of fixing · Verification**,
then the evidence tag and the status. Effort: S < ½ day, M ≤ 2 days, L more.

### 2.A Architecture and SOLID

**ARC-01** — **Severity:** medium
- **Location:** `src/lib/purge.ts` (worker purge), `src/app/api/sessions/[id]/route.ts:166-300` (session delete `?files=true`), `src/lib/duplicates.ts:234-289, 354-450` (dedup delete/keep), `src/app/api/exports/[id]/route.ts:79-83` (export folder `rm -r`).
- **Problem:** four code paths remove bytes from disk, each with its own guard set. Only the purge worker honours `PURGE_ENABLED`, writes `purge_log` and runs three guards; the session route re-implements containment and skips the switch and the log; dedup skips the switch; the export route derives its `rm -r` target from user input (SEC-01).
- **Impact:** the "originals are sacred" rule is enforced in one place and approximated in three; every finding in this audit that loses data (SEC-01, SEC-04, BE-01, BE-02) sits in a path that bypasses the strongest guard set.
- **Fix:** one `lib/originals.ts` deletion service (switch, containment, zone, a confirmed surviving copy where it applies, audit row) that the three non-worker paths call; no new abstraction beyond that function.
- **Effort:** M · **Risk of fixing:** medium (touches every destructive path; do it after the targeted fixes have tests)
- **Verification:** each caller's tests (batch 1 adds the first ones) pass unchanged against the shared service; `grep -n "rm(" src/app src/lib` shows only the service and staging cleanup.
- *Evidence:* read · *Status:* Batch 9

**ARC-02** — **Severity:** medium
- **Location:** `src/app/api/sessions/route.ts:122-209` vs `src/app/api/sessions/[id]/route.ts:43-95`; `src/app/api/people/route.ts:48-88` vs `src/app/api/people/[id]/route.ts:39-78`; 75 of 111 route files carry inline SQL.
- **Problem:** business queries live in route handlers, and the two that exist twice have already drifted — the session list computes `unplaced_count`, the detail `live_count`, neither both.
- **Impact:** a session card and its detail page can disagree about the same session; every new counter must be added twice.
- **Fix:** `lib/sessions.ts` with one stats fragment and `lib/people.ts listPeople/getPerson`. Only the duplicated pairs move (second-occurrence rule); single-use inline SQL stays.
- **Effort:** M · **Risk of fixing:** low
- **Verification:** both routes return identical counters for a seeded session (an integration test on the harness).
- *Evidence:* sweep + read (sessions) · *Status:* Batch 8

**ARC-03** — **Severity:** medium
- **Location:** `src/worker.ts:95-107` (index), `:137-141` (derivatives), `:209-213` (gpswrite), `src/lib/ml.ts:405-411`, `src/lib/geocode.ts:193-195, 234-240`.
- **Problem:** "may this stage run now, and how long to wait" — pause flag + `reserveSlot()` — is recomputed at five sites with two different waiting styles (review C5).
- **Impact:** the planned *quiet hours* (SETTINGS-UI E19) would have to be taught to all five sites, plus `settings.ts` in four places; the next pacing rule drifts the same way.
- **Fix:** `pace(stage): Promise<{ paused: boolean; waitMs: number }>` in `lib/rate.ts`, called by the five sites; quiet hours then become one branch in it.
- **Effort:** M · **Risk of fixing:** medium (pipeline timing)
- **Verification:** unit tests on `pace()` (paused / under budget / over budget); a worker run shows the same `reserveSlot` cadence before and after.
- *Evidence:* read · *Status:* Batch 9 (with quiet hours)

**ARC-04** — **Severity:** medium
- **Location:** `src/lib/db.ts:21-40` (`global.__winnowPool` only set when `NODE_ENV !== "production"`); `src/lib/auth.ts:190-194` (states the proxy and routes are separate bundles).
- **Problem:** in production each bundle that imports `db.ts` builds its own pool, so the per-process cap `DB_POOL_MAX` is per bundle, contradicting the comments in `db.ts:26` and `auth.ts:191`.
- **Impact:** the app can hold a multiple of `DB_POOL_MAX` connections; the sizing rule "sum of concurrencies ≤ DB_POOL_MAX" in the review is wrong by that factor.
- **Fix:** anchor the pool on `globalThis` unconditionally (`global.__winnowPool ??= new pg.Pool(…)`), as `auth.ts` already does for its cache.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** reproduced — `next start` with `DB_POOL_MAX=10`, 40 concurrent `/api/facets`: `pg_stat_activity` shows **13** `winnow-app` connections (> 10, so > 1 pool). After the fix the count must never exceed 10.
- *Evidence:* reproduced · *Status:* Batch 3

**ARC-05** — **Severity:** low
- **Location:** `src/lib/assetActions.ts`, `src/lib/fetchJson.ts`, `src/lib/cn.ts` (client code in `lib/`); client imports of types from DB-backed modules: `heatmap/*` → `lib/heat`, `timeline/*` → `lib/timeline`, `DevicePickerModal.tsx:22` → `lib/deviceAttribution`, `ChapterEditModal.tsx:16` → `lib/geocode`.
- **Problem:** the client/server boundary holds only because those imports are `import type` and get erased; nothing fails if one becomes a value import (no `server-only` guard, `verbatimModuleSyntax` off).
- **Impact:** one edited import puts `pg`/`config.ts` (S3 credentials) into the browser bundle; the memory records this already broke the build once.
- **Fix:** move the shared types into `*Types.ts` (the pattern `unplacedTypes.ts`/`duplicateTypes.ts` already use) and add `if (typeof window !== "undefined") throw` at the top of `config.ts`.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** `npm run build` green; deliberately importing a value from `config.ts` in a client file fails loudly.
- *Evidence:* sweep · *Status:* Batch 8

**ARC-06** — **Severity:** low
- **Location:** failure kinds (`lib/failures.ts`, `api/failures/route.ts`, `api/failures/retry/route.ts:37`, `api/stats/route.ts:133`, `useStats.ts:71`, `failures/model.ts:118`, `FailuresNav.tsx`, + page); export targets (9 sites); queues (`queue.ts` ×3, `worker.ts`, `getQueueStats` hard-coded to 4).
- **Problem:** adding a variant edits 6–9 files; names have drifted (`gpsWrite`/`gpswrite`, kind `derivative` vs slug `analyze`).
- **Impact:** a forgotten site is a silent gap (a kind counted but not retryable).
- **Fix:** a failure-kind registry in `lib/failures.ts` **when the next kind lands** (notifications, E23, will need it). Leave export targets and queues alone: no new variant is planned.
- **Effort:** M · **Risk of fixing:** low
- **Verification:** adding a test kind touches one file.
- *Evidence:* sweep · *Status:* Won't now (§3.3)

**ARC-07** — **Severity:** low
- **Location:** `src/lib/queue.ts:1-4` ("three queues"; there are nine), `src/lib/roles.ts:5-8` (claims no duplication; 12 SQL copies), `src/lib/failures.ts:1-3` (describes a resolver nothing calls), `src/lib/db.ts:26` + `auth.ts:191` (ARC-04), `src/lib/format.ts:1-3`, `PipelineAssetList.tsx:271`, `docs/ARCHITECTURE-REVIEW.md:144,146` (stale sizes).
- **Problem:** comments that state what the code no longer does — in a codebase whose comments are its design record.
- **Impact:** the next reader trusts the comment.
- **Fix:** correct each sentence; no code change.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** each sentence re-read against the code it describes.
- *Evidence:* sweep · *Status:* Batch 8

### 2.B Reusable components and shared code

**SHR-01** — **Severity:** medium
- **Location:** `src/lib/assetActions.ts:13, 106, 121, 136`; `GalleryShell.tsx:552, 566`; `SessionGrid.tsx:371`; `TimelinePanel.tsx:265`; `SiftSession.tsx:142, 160`.
- **Problem:** there is no shared client mutation helper; each cull write is a bare `fetch` whose result is never checked, and nothing in `src/app` handles a 401.
- **Impact:** the root cause of UX-01 (picks that look saved and are not).
- **Fix:** `lib/client/mutate.ts` — `mutate(url, init)` that throws on `!res.ok`, maps 401 to a `/login?next=` redirect, and returns typed JSON; the optimistic callers revert in their `catch`. It does **not** retry, queue offline, or own any UI.
- **Effort:** M · **Risk of fixing:** low
- **Verification:** with the server returning 500 for `/api/assets/:id/rating`, the tile reverts and a notice appears (browser check).
- *Evidence:* read · *Status:* Batch 5

**SHR-02** — **Severity:** medium
- **Location:** 38 route files parse `params.id` by hand; 10 never check the result (`assets/[id]/{exports,proxy,thumb,rating,route}`, `export/[id]`, `import/[id]`, `sessions/[id]/assets`, `sessions/[id]/route.ts:117`, `tags/[id]`).
- **Problem:** `/api/assets/abc/thumb` sends `NaN` to Postgres; `parseInt("12abc")` is accepted as 12.
- **Impact:** a 500 carrying the pg error text (SEC-09) instead of a 400; wrong-object reads for malformed ids.
- **Fix:** `parseId(raw)` in `lib/api.ts` (`/^\d+$/`, ≤ 2³¹−1) used by every `[id]` route.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** unit test on `parseId`; `curl /api/assets/abc` → 400.
- *Evidence:* sweep · *Status:* Batch 8

**SHR-03** — **Severity:** low
- **Location:** `contentDisposition()` ×7 (`assets/[id]/download:17`, `assets/download:21`, `sessions/[id]/download:19`, `exports/[id]/download:16`, `exports/[id]/items/[itemId]:17`, `sidecars/[id]/download:18`, `failures/duplicates/file:18`); `numbered()` ×4; stat→stream→`as unknown as BodyInit` ×5.
- **Problem:** identical download plumbing copied per route (all seven copies are correct today — they strip CR/LF and quotes).
- **Impact:** a fix to one (e.g. Range support on originals) has to be made seven times.
- **Fix:** `lib/download.ts` with `contentDisposition`, `numbered`, `fileResponse(abs, name)`.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** unit tests on `contentDisposition` (quotes, non-ASCII, CR/LF) and `numbered`.
- *Evidence:* sweep · *Status:* Batch 8

**SHR-04** — **Severity:** low
- **Location:** 42 sites of `Schema.safeParse(await req.json())`, 36 without a `.catch`.
- **Problem:** a malformed JSON body throws before the schema runs.
- **Impact:** 500 instead of 400 for a client mistake.
- **Fix:** `readBody(req, Schema)` in `lib/api.ts` returning `badRequest` on invalid JSON or schema.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** `curl -d '{' …` → 400 on a converted route.
- *Evidence:* sweep · *Status:* Batch 8

**SHR-05** — **Severity:** low
- **Location:** `fmtDate` ×3 (`SessionsPane:98`, `ExportCard:94`, `SessionGrid:173`), `formatBytes` ×3 disagreeing on precision (`format.ts:6`, `failures/model.ts:140`, `ImportPanel.tsx:107`), `formatWhen` ×3; 75 locale-less `toLocaleString`/`NumberFormat` calls.
- **Problem:** formatting is re-implemented locally, against the en-GB rule in `docs/memory/frontend.md`.
- **Impact:** the same date reads differently on two screens and follows the browser locale on others.
- **Fix:** make `lib/format.ts` the only home (pass `"en-GB"` everywhere) and delete the local copies as their files are touched.
- **Effort:** S · **Risk of fixing:** low (visible text changes)
- **Verification:** unit tests on the formatters; a grep for `toLocaleString()` with no locale returns nothing.
- *Evidence:* sweep · *Status:* Batch 8

**SHR-06** — **Severity:** low
- **Location:** 20 `.modal-overlay` shells in 17 files; 10 without `useOverlayDismiss`.
- **Problem:** each modal hand-rolls backdrop, Escape and (absent) focus handling.
- **Impact:** A11Y-04 must otherwise be fixed 20 times.
- **Fix:** `<Modal>` in `ui.tsx` built on a `useDialog` hook (focus in, trap, Escape, restore). It does **not** own layout or buttons.
- **Effort:** M · **Risk of fixing:** low
- **Verification:** keyboard pass on three converted modals (ConfirmDialog, DeleteSessionModal, TokensPanel).
- *Evidence:* sweep · *Status:* Batch 7

**SHR-07** — **Severity:** medium
- **Location:** `src/app/globals.css` — 18 distinct `z-index` values (0–1300) and no `--z-*` tokens; `.bulk-bar` z-55 (`:3464`) vs `.modal-overlay` z-50 (`:5092`); `.viewer` z-50 (`:2134`).
- **Problem:** stacking is magic numbers. The bulk bar (z-55) sits **above** the modals it opens (z-50), contradicting its own comment; the viewer and modals tie at 50 and are ordered by DOM position.
- **Impact:** the bulk bar stays clickable over the Export/Geotag modal; a modal opened from the viewer may open behind it (needs a browser check).
- **Fix:** a token scale (`--z-raised`, `--z-sticky`, `--z-overlay`, `--z-modal`, `--z-popover`, `--z-toast`) and one scrim class.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** open Export from the bulk bar and from the viewer; the modal is on top in both.
- *Evidence:* sweep (values) · *Status:* Batch 7

**SHR-08** — **Severity:** low
- **Location:** `globals.css` and tsx: 69 hex and 92 `rgba()` literals outside the token block, 41 distinct `rgba`; scrims spelled three ways; `HeatBins.tsx:30,36` hardcode `#d9442a`, `#1b1813`.
- **Problem / Impact:** colours drift from the Paper tokens (UI-REVIEW T5/T6 covers the visible part).
- **Fix:** replace on touch; one `--color-scrim`.
- **Effort:** S · **Risk of fixing:** low · **Verification:** grep count goes down; light/dark screenshots unchanged.
- *Evidence:* sweep · *Status:* Batch 7

**SHR-09** — **Severity:** low
- **Location:** root-kind lists hard-coded in SQL at 12 sites (`reconcile.ts:67`, `search/route.ts:121`, `purge.ts:39`, …) despite `lib/roles.ts`; path-under-root checks ×9, two without a separator check (`import.ts:286`, `:308` — the latter followed by `rm -r`).
- **Problem / Impact:** a new root kind must be added 12 times; `startsWith(dir)` without `+ "/"` matches a sibling `dir-evil`.
- **Fix:** SQL constants exported by `roles.ts`; one `isWithin(target, root)` helper.
- **Effort:** S · **Risk of fixing:** low · **Verification:** unit test on `isWithin` (`/a/b` vs `/a/bc`).
- *Evidence:* sweep · *Status:* Batch 8

**Proposed shared layer** (nothing else):

| Module | Purpose | Public API | Used by | Explicitly does not |
|---|---|---|---|---|
| `lib/client/mutate.ts` | checked client writes | `mutate<T>(url, init): Promise<T>` | every optimistic cull write | retry, queue offline, render UI |
| `lib/api.ts` (+) | request parsing | `parseId`, `readBody`, generic `serverError` | every route | authorise (that stays in `proxy.ts`) |
| `lib/download.ts` | file responses | `contentDisposition`, `numbered`, `fileResponse` | 7 download routes | read originals the indexer has not listed |
| `lib/originals.ts` | the only way bytes leave disk | `removeOriginal(path, ctx)` | session delete, dedup, export delete | decide *what* to delete |
| `lib/rate.ts` (+) | pacing policy | `pace(stage)` | 5 throttle sites | concurrency (stays env) |
| `lib/sessions.ts` | session counters | `SESSION_STATS_SQL`, `getSessionStats` | 2 session routes | paginate (BE-06 decides that) |
| `ui.tsx` (+) | dialogs | `<Modal>`, `useDialog` | 20 modal shells | layout, buttons |
| `globals.css` (+) | stacking | `--z-*` tokens | every positioned layer | — |

### 2.C Security

Ordered by severity, then exploitability. "Same-site page" means any page on
another subdomain of the site Winnow is served under (the cookie is
`SameSite=Lax`, which a sibling subdomain satisfies).

**SEC-01** — **Severity:** critical
- **Location:** `src/lib/export.ts:54-56` (`sanitize` keeps `.`), `:314` (`destDir = path.join(config.exportDir, sanitize(job.name))`), `src/app/api/exports/[id]/route.ts:79-83` (`rm(…, { recursive: true, force: true })`); the name comes from `POST /api/export` (`z.string().min(1)`).
- **Problem:** `sanitize("..")` is `".."` and `sanitize(".")` is `"."`, so an export named `..` uses `/data` as its folder and one named `.` uses `EXPORT_DIR` itself. Deleting that export runs `rm -r` on it.
- **Impact:** any **editor** — or an editor-ceiling app token on a phone — creates an export named `..`, deletes it, and Winnow recursively deletes `/data`: the inbox (which can hold originals not yet imported), the whole derivative cache (every thumb and proxy: days of HDD re-reads to rebuild) and every export. Named `.`, it deletes every export of every user. One mistyped name does the same.
- **Fix:** map dot-only names to a safe folder name in `sanitize`, and refuse to copy into or remove any folder that does not resolve strictly inside `EXPORT_DIR`.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** `node -e` over `sanitize` printed `".." -> /data`, `"." -> /data/exports`. Regression test: every dot-only name and traversal attempt resolves strictly inside `EXPORT_DIR`; deleting a job whose folder would escape removes nothing.
- *Evidence:* read + reproduced · *Status:* **Fixed (batch 1)**

**SEC-02** — **Severity:** critical
- **Location:** `package.json` (`next ^16.2.12` resolved 16.2.12, `sharp 0.35.3` via `overrides`); `src/proxy.ts:59-61` (matcher excludes `/_next/`).
- **Problem:** `npm audit --omit=dev`: **critical** GHSA-2xp9-vwfh-vxw4 (Next.js unauthenticated RCE in the Image Optimization API "when AVIF files are used", fixed 16.3.3), GHSA-vcvr-r3jv-pc5j (`next/og`, unused here), GHSA-p293-qw3h-jr36 (Windows-only); **high** GHSA-rgj7-g3m4-5g8c (libheif inside sharp < 0.35.4 — sharp decodes uploaded HEIF/AVIF); high nanoid. The app never uses `next/image` (0 imports), yet the optimizer is live and **outside the auth guard**.
- **Impact:** an unauthenticated internet request reaches the vulnerable optimizer through the tunnel; an editor-uploaded HEIF reaches libheif in the worker.
- **Fix:** upgrade `next` to 16.3.8 and the `sharp` override to 0.35.5 (`npm audit fix` for nanoid), and set `images.unoptimized: true` so the unused optimizer stops serving at all.
- **Effort:** S · **Risk of fixing:** medium (framework minor bump — gated by typecheck, build and a browser smoke test)
- **Verification:** before: `curl /_next/image?url=%2Ficons%2Ficon-192.png&w=64&q=75` without a cookie → **HTTP 200 image/png**. After: `npm audit --omit=dev` → 0 critical/high; the same curl no longer optimises; pages and media still load.
- *Evidence:* reproduced · *Status:* **Fixed (batch 1)**

**SEC-03** — **Severity:** high
- **Location:** `src/proxy.ts` (no Origin / Sec-Fetch-Site check); every one of the 45 POST handlers parses with `req.json()`, which ignores `Content-Type`; only `apps/[app]/docs/[id]` checks it.
- **Problem:** there is no CSRF defence beyond `SameSite=Lax`, and Lax does not separate sibling subdomains. A `<form enctype="text/plain" method="POST">` on any same-site page is a "simple request" (no preflight) that carries the cookie, and the routes accept its body as JSON.
- **Impact:** a script or form on any other `*.steeve.website` page (XSS there, user content there, a dangling subdomain) silently drives the victim's account: overwrite every verdict (`/api/ratings/bulk`), trash media (`/api/assets/delete`), and as an admin start a purge of the trash (`/api/purge`) — physical deletion of Incoming originals. Responses cannot be read, so token/user creation leaks nothing, but every write lands.
- **Fix:** in `proxy.ts`, for a mutating API request that authenticated by cookie, require `Sec-Fetch-Site` ∈ {`same-origin`, `none`} or, when the header is absent, an `Origin` equal to the request's own origin or in `CORS_ALLOWED_ORIGINS`; otherwise 403. Bearer-token requests are immune and unaffected.
- **Effort:** S · **Risk of fixing:** medium (a wrong origin comparison behind Traefik/Cloudflare would lock out writes — needs the forwarded-host check tested through the real proxy)
- **Verification:** reproduced — a `text/plain` POST with `Origin: https://other.example.website`, `Sec-Fetch-Site: same-site` and the session cookie rewrote three verdicts (**HTTP 200, `{"updated":3}`**). After: 403; the app's own UI and Atelier's allowlisted origin still write.
- *Evidence:* reproduced · *Status:* Decision D1 → Batch 2

**SEC-04** — **Severity:** high
- **Location:** `src/app/api/sessions/[id]/route.ts:177, 216-263` (`?files=true` → `rm` of every asset and sidecar); `src/lib/authz.ts:213-263` (no admin rule for it; DELETE defaults to editor).
- **Problem:** an editor can permanently delete every original of an Incoming session in one request, while emptying the trash (`/api/purge`) is admin-only, honours `PURGE_ENABLED` and writes `purge_log`. The session route does none of those.
- **Impact:** the role model's most destructive verb is reachable one role lower, without the kill switch or the audit trail, and the cascade drops the asset rows that would say what was lost.
- **Fix:** require admin for `files=true` (in the handler, from `x-winnow-user-role`, so `authz.ts` stays method/path-only) and route the deletion through the purge guards (ARC-01).
- **Effort:** S · **Risk of fixing:** low (editors lose a capability — intended)
- **Verification:** editor cookie → 403 with `files=true`, 200 without; admin → 200.
- *Evidence:* read · *Status:* Decision D3 → Batch 2

**SEC-05** — **Severity:** high
- **Location:** `src/lib/api.ts:24-27` (`clientIp` = first `X-Forwarded-For` hop), `src/lib/auth.ts:398-420` (`ip|username` key, `clear()` at 10k keys), `src/app/api/auth/me/route.ts:73-81` (current-password check, no throttle).
- **Problem:** the throttle key's IP is whatever the client puts first in `X-Forwarded-For` — Cloudflare appends to a client-supplied header rather than replacing it.
- **Impact:** if Traefik passes the header through, an internet attacker gets unlimited password guesses against the admin account by changing one header per attempt. If Traefik overwrites it with cloudflared's address instead, every visitor shares one key per username and anyone locks the admin out with 10 bad tries. Either way the brake is broken; which way depends on Traefik's trust config (§1.7).
- **Fix:** key on `CF-Connecting-IP` (set by Cloudflare per request) and fall back to the last hop added by the trusted proxy; add a per-account cap that slows (not locks) after N failures; evict oldest instead of `clear()`; apply the same brake to the password-change check.
- **Effort:** S · **Risk of fixing:** medium (a wrong header choice either locks people out or re-opens the hole)
- **Verification:** reproduced — 12 failed logins with a fixed XFF → `401 ×10, 429 ×2`; with a rotating XFF → `401 ×12`, never throttled. After: rotating XFF is throttled too.
- *Evidence:* reproduced · *Status:* Decision D4 → Batch 2

**SEC-06** — **Severity:** medium
- **Location:** `src/app/login/LoginForm.tsx:15-18` (`safeNext` rejects `//` but not `/\`), `:75` (`router.replace(next)`).
- **Problem:** `/\evil.example` passes the check; the browser's URL parser turns the backslash into a slash, Next's router sees an external URL and hard-navigates there.
- **Impact:** a link `/login?next=/%5Cevil.example/…` on the real Winnow domain sends the user, just after a genuine sign-in, to a look-alike page ("session expired, sign in again") — a credible phishing hop.
- **Fix:** resolve with `new URL(raw, location.origin)` and accept only a same-origin result, else `/library`.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** reproduced in headless Chromium: signing in at `/login?next=/%5Cevil.example/phish` navigated to `http://evil.example/phish`. After: lands on `/library`.
- *Evidence:* reproduced · *Status:* Batch 2 (touches auth)

**SEC-07** — **Severity:** medium
- **Location:** `src/app/api/import/offload/route.ts:9-26` (`z.string().min(1)`, straight to `enqueueImport`).
- **Problem:** the card-offload source can be any directory the container can read; `/api/fs` is confined to the browse roots but this route is not.
- **Impact:** an editor copies any readable tree's media-extension files into Incoming, where every viewer can browse and download them. Non-destructive (`removeAfter: false`).
- **Fix:** refuse paths outside `isWithinBrowseRoots()`. This would break an offload from a card mounted outside `BROWSE_ROOTS`, so the mount must be listed first.
- **Effort:** S · **Risk of fixing:** medium (depends on where cards are mounted on the Optiplex)
- **Verification:** `POST {path:"/etc"}` → 400; a browse-root path → 202.
- *Evidence:* read · *Status:* Decision D11

**SEC-08** — **Severity:** medium
- **Location:** `next.config.mjs` (no `headers()`, no `poweredByHeader: false`); no header set in `proxy.ts` or any route.
- **Problem:** no `Content-Security-Policy`/`frame-ancestors`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` or HSTS; `X-Powered-By: Next.js` is sent.
- **Impact:** a same-site page can frame the signed-in app for clickjacking (the People merge is one click, UX-02); user-uploaded app files can be MIME-sniffed (SEC-10).
- **Fix:** `nosniff`, `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `poweredByHeader: false`; a full CSP later (the pre-paint theme script needs a hash).
- **Effort:** S · **Risk of fixing:** low (confirm nothing frames Winnow — Atelier calls the API, it does not embed pages)
- **Verification:** reproduced (before): `curl -I /login` shows only `X-Powered-By`, `Cache-Control`, `Content-Type`. After: the headers above.
- *Evidence:* reproduced · *Status:* Batch 2

**SEC-09** — **Severity:** low
- **Location:** `src/lib/api.ts:16-20` (`serverError` returns `err.message`), used by 109 routes.
- **Problem:** raw pg/ioredis/fs messages reach every viewer.
- **Impact:** internal hostnames, SQL fragments and paths in the UI (`connect ECONNREFUSED 10.x:5432`); also UX-05's unreadable errors.
- **Fix:** log the error with a short id and return a generic message plus the id; keep explicit, user-fixable messages through typed errors (`BrowseError`, `DuplicateError` already exist).
- **Effort:** M · **Risk of fixing:** medium (21 views print `body.error`)
- **Verification:** a forced DB error returns `{error:"Internal error (ref …)"}`; the log line carries the same ref.
- *Evidence:* read · *Status:* Decision D15 → Batch 8

**SEC-10** — **Severity:** low
- **Location:** `src/lib/appFiles.ts:42-60` (`FORBIDDEN_MEDIA` = html/svg/xhtml only), `src/app/api/apps/[app]/files/[id]/route.ts:70-72` (served inline, no `nosniff`, no `Content-Disposition`).
- **Problem:** a client-declared `text/xml`/`application/xml` body (XHTML-namespaced script runs in XML documents) is served back inline on the Winnow origin.
- **Impact:** rows are owner-scoped (another user gets 404), so this is self-XSS only today; it becomes stored XSS the day files are shared.
- **Fix:** add the XML types to the forbidden list and send `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox` on app-file responses.
- **Effort:** S · **Risk of fixing:** low · **Verification:** PUT an `application/xml` file → served as `application/octet-stream`.
- *Evidence:* read · *Status:* Batch 2

**SEC-11** — **Severity:** low
- **Location:** `src/app/api/apps/[app]/files/[id]/route.ts:87` (`req.arrayBuffer()`, no cap since 2026-09-24 by decision), `src/app/api/apps/[app]/docs/[id]/route.ts:82-88` (`req.text()` before the size check when no `Content-Length`).
- **Problem:** both viewer-reachable PUTs buffer the whole body.
- **Impact:** any signed-in account can push the app process (no `mem_limit`) into the host's OOM killer with one large or chunked body.
- **Fix:** files: stream-hash into a temp file, then rename (no cap needed for that); docs: a byte-counting reader that aborts at `MAX_DOC_BYTES`.
- **Effort:** S · **Risk of fixing:** low · **Verification:** a 2 GB chunked PUT keeps RSS flat (files) / gets a 413 at 1 MiB (docs).
- *Evidence:* read · *Status:* Batch 6

**SEC-12** — **Severity:** low
- **Location:** `src/app/api/db/backup/route.ts:73-75` (`--dbname=${config.databaseUrl}`).
- **Problem / Impact:** the Postgres password sits in `pg_dump`'s argv, readable in `/proc/<pid>/cmdline` inside the app container while a dump runs.
- **Fix:** pass `PGHOST/PGUSER/PGPASSWORD/PGDATABASE` through `env`.
- **Effort:** S · **Risk of fixing:** low · **Verification:** `cat /proc/<pid>/cmdline` during a dump shows no password.
- *Evidence:* sweep · *Status:* Batch 3

**SEC-13** — **Severity:** low
- **Location:** `src/app/api/auth/setup/route.ts:38-60` (check-then-insert), `src/app/api/auth/users/[id]/route.ts:59-66` (last-admin count then update).
- **Problem / Impact:** two concurrent first-run setups can both create an admin; two admins demoting each other can both succeed. Narrow windows, but auth state.
- **Fix:** single conditional statements (`INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM users)`; `UPDATE … WHERE (SELECT count(*) …) > 1`).
- **Effort:** S · **Risk of fixing:** low · **Verification:** two parallel setup POSTs → one 200, one 403.
- *Evidence:* sweep · *Status:* Batch 2

*Checked and fine:* the identity-header strip in `proxy.ts:160-168`; scrypt parameters and the dummy-hash timing equaliser; sessions/invites/tokens stored as SHA-256; token caps (`authz.ts:265-320`); CORS exact-origin allowlist; `/api/fs` and `fsbrowse.ts` (logical + realpath containment); `/api/upload` path sanitising (`safeRelPath`); `/api/failures/duplicates/file` (DB whitelist); every SQL interpolation (164 sites) is a hard-coded identifier or a `$n` placeholder; no GET handler writes, enqueues or touches the filesystem; every server-side `fetch` URL is built from config plus encoded parameters (no SSRF); the four `dangerouslySetInnerHTML` sites are static or build-time strings; lockfile in sync, install scripts limited to esbuild/fsevents/msgpackr-extract.

### 2.D Performance — frontend and UI

Measured where it says so; "mechanism" means the cost follows from how the
code and React/react-window work, without a frame trace.

**FE-01** — **Severity:** high
- **Location:** `src/app/gallery/GalleryShell.tsx:449-452` (`if (loadingRef.current) return;`) with the reset effect at `:478-484`; same shape in `src/app/sessions/[id]/SessionGrid.tsx:305, 341-345`.
- **Problem:** a filter change while a page request is in flight clears the grid and calls `fetchPage(null)`, which returns immediately because of the in-flight guard; the old request then lands and fills the grid with the *previous* filter's rows and cursor.
- **Impact:** the chips say one filter, the grid shows another, with no sign anything is wrong — easy to hit with fast chip taps, the RangeSlider number fields, or pull-to-refresh during a scroll page.
- **Fix:** tag each request with a generation (or an `AbortController` keyed on the filter) and drop stale responses instead of skipping the reset fetch.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** throttle the network in devtools, change a filter during a page load: the grid shows only the new filter's rows.
- *Evidence:* read · *Status:* Batch 5

**FE-02** — **Severity:** medium
- **Location:** `src/app/useStats.ts:131` (5 s), `src/app/SessionsPane.tsx:360` (5 s), `useFailures`, `Scanning`/`MlQueuePanel` (5 s), `PipelineAssetList` (8 s) — none checks `document.visibilityState` (only `ConnectionStatus.tsx` does).
- **Problem:** a backgrounded tab or a home-screen PWA left open polls forever.
- **Impact:** measured on the synthetic 100k library: `/api/sessions` **830 ms** per call (BE-06), `/api/stats` 86 ms, `/api/facets` 98 ms. One forgotten Library tab costs the Optiplex ~17 % of a core continuously; the sweep's "stats/facets saturate the pool" claim does **not** hold at 100k.
- **Fix:** one `usePoll(fn, ms)` hook: pause while hidden, skip while in flight, back off when the queues are idle.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** with the tab hidden, the server log shows no `/api/sessions` requests; visible again → one immediate refresh.
- *Evidence:* reproduced (timings) + read · *Status:* Batch 6

**FE-03** — **Severity:** medium
- **Location:** `SessionsPane.tsx:318-339`, `search/SearchPage.tsx:186`, `settings/pipeline/PipelineAssetList.tsx:376`.
- **Problem / Impact:** effect fetches without a stale-response guard: switching filter or source mid-request leaves the older answer on screen.
- **Fix:** the FE-01 generation pattern in each effect's cleanup.
- **Effort:** S · **Risk of fixing:** low · **Verification:** same throttled-network check as FE-01.
- *Evidence:* sweep · *Status:* Batch 5

**FE-04** — **Severity:** medium
- **Location:** `src/app/sessions/[id]/SessionGrid.tsx:990` (`assets.map(...)` with inline closures, no memo).
- **Problem:** the session page is the one big grid not on `VirtualGrid`; infinite scroll keeps every cell mounted and each rating re-renders all of them.
- **Impact:** a 3,000-frame session on a phone grows thousands of DOM nodes and janks on every verdict (mechanism; the Gallery grid's measured fix in `docs/memory/frontend.md` is the same class).
- **Fix:** render it through `VirtualGrid`/`Tile`.
- **Effort:** M · **Risk of fixing:** medium (burst/pair badges and selection must carry over)
- **Verification:** the memory's rAF step-scroll page on a 3,000-item session: frames on vsync, DOM node count bounded.
- *Evidence:* sweep · *Status:* Batch 6

**FE-05** — **Severity:** low
- **Location:** `search/SearchPage.tsx:304`, `people/[id]/PersonDetail.tsx:396`, `settings/pipeline/PipelineAssetList.tsx:479`.
- **Problem / Impact:** inline arrows handed to `VirtualGrid` re-render every tile on each keystroke in the page's text field — the exact pattern `docs/memory/frontend.md` forbids.
- **Fix:** `useCallback`, as `GalleryShell` does. **Effort:** S · **Risk:** low · **Verification:** React profiler: typing renders no `Tile`.
- *Evidence:* sweep · *Status:* Batch 6

**FE-06** — **Severity:** low
- **Location:** `src/app/sift/SwipeDeck.tsx:288-295` (`setDrag` per pointer move), `:528`, `:752` (inline `onRate`, grid-level `liveHoverId`).
- **Problem / Impact:** every pointer move re-renders the 760-line deck and the recent strip (mechanism, not measured).
- **Fix:** drive the drag transform through a ref / CSS variable; stable callbacks. **Measure first** with the profiler on a phone.
- **Effort:** M · **Risk:** medium · **Verification:** profiler: a drag renders only the card.
- *Evidence:* sweep · *Status:* Batch 6 (after a measurement)

**FE-07** — **Severity:** low
- **Location:** `src/app/sift/[id]/SiftSession.tsx:81-95` (up to 10 sequential page requests before the first card).
- **Fix:** show the deck after page 1, fetch the rest behind it. **Effort:** S · **Risk:** low · **Verification:** first card appears after one round trip.
- *Evidence:* sweep · *Status:* Batch 6

**FE-08** — **Severity:** low
- **Location:** `settings/import/ImportPanel.tsx:136-162` (interval never cleared on unmount), `settings/pipeline/failures/RelinkSection.tsx:90-95` (keeps polling a completed job).
- **Fix:** clear on unmount, stop on `finished`. **Effort:** S · **Risk:** low · **Verification:** network panel quiet after leaving the page.
- *Evidence:* sweep · *Status:* Batch 5

**FE-09** — **Severity:** low
- **Location:** `MediaViewer.tsx:345-366, 836-853`, `gallery/SimilarStrip.tsx:45-57`.
- **Problem / Impact:** holding an arrow key fires 2–3 requests per step, none cancelled; `/similar` is a scan (BE-21).
- **Fix:** debounce ~150 ms after the index settles, abort on step. **Effort:** S · **Risk:** low · **Verification:** holding → for 2 s issues ≤ 3 requests.
- *Evidence:* sweep · *Status:* Batch 6

**FE-10** — **Severity:** low
- **Location:** build output `.next/static/chunks`; `package.json:33` (`geist`).
- **Problem:** measured — 64 client chunks, 2.1 MB raw in total; largest 227 KB raw / 70 KB gzip (framework); Leaflet 145 KB / 41 KB gzip is correctly behind `next/dynamic`; CSS 247 KB / 32 KB gzip. Three font families (via `next/font`, `display: swap`) preload on every route including `/login`. `geist` is a dependency nothing imports.
- **Impact:** small; the bundle is in good shape.
- **Fix:** drop `geist`; nothing else is worth doing without a field LCP number.
- **Effort:** S · **Risk:** low · **Verification:** build green, chunk list unchanged.
- *Evidence:* reproduced · *Status:* Batch 8

*Checked and fine:* lazy thumbs inside fixed-size cells (no CLS); raw `<img>` is right for API-served thumbs; no `key={index}` on reorderable lists; no client file imports a server module at runtime; `useStats` dedupes in-flight requests; `ConnectionStatus` pauses while hidden.

### 2.E Performance and correctness — database and backend

**BE-01** — **Severity:** high
- **Location:** `src/lib/import.ts:189-206` and `:227-239` (`if (same !== false) { … if (args.removeAfter) await rm(src) }`); `src/lib/hash.ts:73-83` (`sameContent` → `null` when either file cannot be read).
- **Problem:** an import treats "could not verify" exactly like "confirmed duplicate" and deletes the source. The lookup also matches **purged** rows, which keep their `content_hash` by design (open item in `MEMORY.md`) and have no file left.
- **Impact:** re-importing a photo whose library copy was purged, moved or removed by hand — through web upload or an inbox/FTP drop (`removeAfter: true`) — deletes the new bytes and reports a "duplicate". The library holds no copy; the user formats the card believing it imported. This is the exact loss the comment above the check says it prevents.
- **Fix:** delete the source only on `same === true`; on `null`, record the hit and quarantine the file through the existing error path (`.failed`), so the bytes survive and the batch reports it.
- **Effort:** S · **Risk of fixing:** low (more conservative; only the unverifiable case changes)
- **Verification:** regression test with a real Postgres: an asset row holding the file's partial hash at a non-existent path; `runImport(removeAfter)` must leave the bytes in quarantine and count a failure, not a duplicate.
- *Evidence:* read · *Status:* **Batch 1**

**BE-02** — **Severity:** high
- **Location:** `src/lib/duplicates.ts:354-450` (`keepOneCopy`: no existence check on `keepPath`; deletes members with `verified IS NOT FALSE`, i.e. including never-verified ones), `:234-289` (`deleteDuplicateFiles`: deletes a recorded copy without confirming any other copy exists).
- **Problem:** both dedup actions remove files on the strength of a `duplicate_hits` row that may be stale. A row is recorded *unverifiable* precisely when the other side could not be read — the documented "moved original" state (`docs/memory/pipeline.md`).
- **Impact:** "Keep only this copy" on a copy that has since gone relinks the library row to nothing and deletes the real file; "Delete the file" on a moved original's new location deletes the only copy. "Resolve all" runs `keepOneCopy` for up to 500 groups in one click.
- **Fix:** never remove a copy unless another copy of the same content is on disk now: `keepOneCopy` refuses when `keepPath` is gone and deletes a member only when the pair is known-equal (both verified) and sizes match, or a fresh full compare says so; `deleteDuplicateFiles` requires the same of the library copy.
- **Effort:** M · **Risk of fixing:** low (only refusals are added; the verified common case keeps its cost)
- **Verification:** regression tests: keep with a vanished `keepPath` deletes nothing; delete of a copy whose library original is gone or unverified deletes nothing; the verified case still deletes.
- *Evidence:* read · *Status:* **Batch 1**

**BE-03** — **Severity:** high
- **Location:** `src/lib/zip.ts:204` (`await readFile(entry.absPath)`), `:31-37` (table CRC); used by `sessions/[id]/download`, `exports/[id]/download`, `assets/download`.
- **Problem:** `fs.readFile` refuses any file over 2 GiB; every entry is read whole into the app process; the JS CRC loop holds the event loop.
- **Impact:** downloading a session or export that contains one long Sony/DJI clip ends mid-stream with a truncated archive after gigabytes; the ZIP64 branch for ≥ 4 GiB files is unreachable; a 1.9 GB clip pins 1.9 GB of RSS and blocks every other request for ~6 s while its CRC runs.
- **Fix:** keep the single read for files ≤ 64 MiB; stream bigger ones twice (CRC pass, then copy, with size and CRC re-checked); native `zlib.crc32` when present. The archive bytes are identical either way.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** reproduced — `readFile` of a 2.2 GB sparse file → `ERR_FS_FILE_TOO_LARGE`; CRC throughput 333 MB/s (table) vs 3,241 MB/s (`zlib.crc32`). Regression tests: streamed and buffered paths produce byte-identical archives, `unzip -t` passes; a 2.2 GB entry archives and verifies.
- *Evidence:* reproduced · *Status:* **Batch 1**

**BE-04** — **Severity:** high
- **Location:** `src/app/api/upload/route.ts:48` (`await req.formData()`); the client sends a whole folder in one XHR (`settings/import/ImportPanel.tsx:166-208`); the app service has no `mem_limit` (`docker-compose-optiplex.yml:223-268`).
- **Problem:** undici's `formData()` reads the entire multipart body into memory before parsing.
- **Impact:** measured — a 300 MB upload grew RSS from 49 MB to **659 MB** (≈ 2× the body). An SD card's worth (tens of GB) cannot succeed and can push the host's OOM killer onto Postgres or the worker. `maxDuration = 600` does nothing under `next start`. Through the tunnel, Cloudflare's per-request cap (100 MB on Free/Pro) likely rejects large uploads first.
- **Fix:** client uploads one file per request into a batch (`PUT /api/upload/:batch?path=…`), the route streams `req.body` straight to disk; a final call enqueues the import. No new dependency; also keeps each request under Cloudflare's cap for photos.
- **Effort:** M · **Risk of fixing:** medium (internal API contract + client)
- **Verification:** reproduced (before, standalone `Request.formData()` on a 300 MB stream). After: a 2 GB upload keeps RSS under ~100 MB.
- *Evidence:* reproduced · *Status:* Decision D5 → Batch 6

**BE-05** — **Severity:** high
- **Location:** `src/lib/exifWrite.ts:48-50` (`exiftool.write(…, ["-overwrite_original_in_place", "-P"])` on the shared singleton); `exiftool-vendored` default `taskTimeoutMillis: 30000`; gpswrite jobs get `attempts: 3`.
- **Problem:** `-overwrite_original_in_place` writes a temp file then copies it back over the original; the library kills an exiftool task that passes 30 s; videos are rewritten whole.
- **Impact:** a manual geotag on a large clip, or a RAW over a busy NAS, can be killed during the copy-back — a **corrupted original**, the one outcome the project's first principle forbids — or leave a multi-GB `_exiftool_tmp` beside it, after which the retries fail on it.
- **Fix:** a dedicated `ExifTool` instance for writes with no task timeout (or one scaled to file size), `attempts: 1` for gpswrite, and a size cap above which video write-back is refused with a readable error.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** write GPS into a sample JPEG and MOV through `runGpsWriteJob` with an artificially slow disk (e.g. `tc`/`dm-delay` or a FUSE throttle) past 30 s: the file is intact and tagged.
- *Evidence:* read (+ library default) · *Status:* Batch 3

**BE-06** — **Severity:** medium
- **Location:** `src/app/api/sessions/route.ts:122-209` (per-session `LEFT JOIN LATERAL` aggregates for **every** session, no LIMIT), polled every 5 s by `SessionsPane.tsx:360`.
- **Problem:** review D1 made the aggregate per-session, but the list still computes it for all sessions on every poll.
- **Impact:** measured **830 ms** per call at 100k assets / 1,000 sessions (warm cache, synthetic); it grows with the library and is paid every 5 s per open Library tab (FE-02).
- **Fix:** keyset-paginate the list (the UI shows a page of cards), or maintain per-session counters with triggers; poll only sessions still processing.
- **Effort:** M · **Risk of fixing:** medium (the progress filter reads the aggregates)
- **Verification:** the same request ≤ 100 ms at 100k; results identical for the first page.
- *Evidence:* reproduced · *Status:* Batch 6

**BE-07** — **Severity:** medium
- **Location:** `src/lib/export.ts:314, 322` (`dest = path.join(destDir, file.filename)` → `rename` over an existing file); folder named by `sanitize(job.name)` only; lineage inserts `:329, 343` with no unique key, jobs retried 3×.
- **Problem:** two different `DSC00001.ARW` in a multi-session export overwrite each other; two jobs with the same name share and overwrite one folder; a retried job re-inserts every lineage row.
- **Impact:** an export silently missing files that the job reports as copied; duplicated lineage doubles the ZIP download.
- **Fix:** `uniqueDest`-style suffixing (the importer's `__N`), the job id in the folder name, `ON CONFLICT DO NOTHING` on a lineage unique key (migration).
- **Effort:** M · **Risk of fixing:** medium (export folder layout is what Capture One reads)
- **Verification:** export two sessions holding the same filename: two files land; retry adds no rows.
- *Evidence:* read · *Status:* Decision D10 → Batch 3

**BE-08** — **Severity:** medium
- **Location:** `src/lib/watcher.ts:23-35` (`awaitWriteFinish` gates only the `add` event), `src/lib/import.ts:177` (the job walks the whole inbox).
- **Problem:** once any one file is stable, the import walks every file in the inbox — including one still being written over SMB/FTP.
- **Impact:** a stalled transfer is copied partial, verifies against its own partial size, and its source is deleted while the writer is still writing: a truncated original indexed as valid.
- **Fix:** import only the paths the watcher saw stabilise, or skip files whose size or mtime changed within the last N seconds.
- **Effort:** M · **Risk of fixing:** low
- **Verification:** start a slow copy into the inbox, drop a second file: the slow one is left alone until it completes.
- *Evidence:* sweep · *Status:* Batch 3

**BE-09** — **Severity:** high
- **Location:** `src/app/api/roots/[id]/route.ts:61-79` (`DELETE FROM roots`), the CASCADE chain in §1.3, `src/app/settings/volumes/VolumesPanel.tsx:89-96` (confirm text), `src/lib/bootstrap.ts:28` (re-adds `INCOMING_DIR` on every worker start).
- **Problem:** removing a volume deletes every verdict, star, tag, person link and export record of its media; the dialog says the files are untouched and "you can re-add the folder later to re-index it", which brings the files back with none of that. Removing the Incoming volume is undone silently at the next worker restart — unrated. The UI also ignores the DELETE's result.
- **Impact:** one admin click, plausibly made to "fix a path", destroys the curation the memory calls the irreplaceable half of the system; only a backup restore recovers it.
- **Fix:** decision — detach (soft) vs refuse while curated vs keep with a typed confirmation that names the counts lost. Interim, independent of the decision: say it in the dialog and check the response.
- **Effort:** S (interim) / M · **Risk of fixing:** low
- **Verification:** seed ratings under a root, remove it: the chosen behaviour holds (refused, or detached and restorable).
- *Evidence:* read · *Status:* Decision D2

**BE-10** — **Severity:** medium
- **Location:** `src/lib/purge.ts:149-207` (re-check, `unlink`, `storage.del`, conditional stamp); restore at `api/assets/delete/route.ts:45`.
- **Problem / Impact:** a restore landing between purge's re-check and its stamp returns a live asset whose original and thumbnails are already gone (logged only).
- **Fix:** claim first (`UPDATE … SET purged_at = now() WHERE … AND purged_at IS NULL RETURNING`), then unlink; on failure revert and record `purge_error`.
- **Effort:** M · **Risk of fixing:** medium · **Verification:** an injected delay between re-check and unlink + a concurrent restore: the restore is refused.
- *Evidence:* sweep · *Status:* Batch 3

**BE-11** — **Severity:** medium
- **Location:** `src/lib/queue.ts:51` (`SCAN_LOCK_TTL_MS` = 6 h), `src/worker.ts:72-75` (skip when locked); no cleanup at boot.
- **Problem / Impact:** a deploy SIGKILLs a running scan (review R8), the Redis lock survives (AOF), and every scan of that root — including post-import ones — completes as "skipped" for up to 6 h: new imports stay invisible.
- **Fix:** clear `winnow:scan-lock:*` in `bootstrapRoots()` (one worker process by design), or a short TTL renewed by a heartbeat.
- **Effort:** S · **Risk of fixing:** low · **Verification:** kill -9 the worker mid-scan, restart: the root scans immediately.
- *Evidence:* read · *Status:* Batch 3

**BE-12** — **Severity:** medium
- **Location:** `src/lib/export.ts:258`, `src/lib/purge.ts:54`, `src/lib/import.ts:172` (status set to `running`); `bootstrap.ts` recovers only `derivative_status='processing'`.
- **Problem / Impact:** a job BullMQ fails as stalled (two deploys during a long export) never runs its `catch`, so `export_jobs`/`purge_jobs`/`import_batches` stay `running` and the session keeps its "exporting" badge forever; an enqueue failure after the INSERT leaves a `queued` row.
- **Fix:** at worker boot, mark `running`/`queued` rows with no live BullMQ job as `error` (or re-enqueue); write the terminal status from `worker.on("failed")` when attempts are exhausted.
- **Effort:** M · **Risk of fixing:** low · **Verification:** kill the worker during an export twice: the row ends `error` with a reason.
- *Evidence:* sweep · *Status:* Batch 3

**BE-13** — **Severity:** medium
- **Location:** `src/lib/queue.ts:10-15` (`maxRetriesPerRequest: null`, default offline queue), shared by the app's queues and rate limiter.
- **Problem / Impact:** during a Redis outage every app request that touches a queue (export, purge, import, upload, scan, backfill, place search) hangs until Cloudflare's 100 s timeout; users retry, and every hung request enqueues when Redis returns — duplicated jobs.
- **Fix:** a separate producer connection for the app with `enableOfflineQueue: false` and a finite `maxRetriesPerRequest`; keep `null` for the worker's `Worker` connections (BullMQ requires it there).
- **Effort:** S · **Risk of fixing:** low · **Verification:** stop Redis, POST an export: a fast 503, no job after Redis returns.
- *Evidence:* read · *Status:* Batch 3

**BE-14** — **Severity:** medium
- **Location:** 47 indexes on `assets` (§1.3); `assets_live_updated_idx` makes `updated_at` an indexed column, and nearly every pipeline write bumps it; `src/lib/serve.ts` also uses `updated_at` as the thumbnail ETag.
- **Problem:** every status change is a non-HOT update writing an entry into all 47 indexes, and invalidates browser thumbnail caches.
- **Impact:** measured on the synthetic library — updating 20k rows' `ml_status` + `updated_at`: **2.9–3.2 s and 77–107 MB WAL** with 47 indexes, **1.7–1.9 s and 52–56 MB** with 20 single-column facet indexes dropped. Real rows are wider; the ratio is the point.
- **Fix:** read `pg_stat_user_indexes` on the Optiplex, drop the never-scanned ones (candidates: `filename_trgm`, `captured_cursor`, `not_deleted`, low-cardinality single columns); stop bumping `updated_at` on internal status changes, with a dedicated `derivative_updated_at` for the ETag.
- **Effort:** M · **Risk of fixing:** medium (migration; needs production statistics)
- **Verification:** the measurement script in this audit's appendix, re-run before/after; `idx_scan` deltas over a week.
- *Evidence:* reproduced · *Status:* Decision D12

**BE-15** — **Severity:** medium
- **Location:** `src/lib/db.ts:35` (`statement_timeout: 30000` on every pool connection), `src/lib/migrate.ts:69` (migrations run on that pool), no `lock_timeout`.
- **Problem / Impact:** a future backfill or index build over 30 s at 500k+ rows is cancelled, `migrate` exits 1 and app/worker never start (`service_completed_successfully`); an `ALTER TABLE assets` with no `lock_timeout` queues behind a long read and stalls every request behind it.
- **Fix:** `SET statement_timeout = 0; SET lock_timeout = '5s'` on the migration client; a per-file marker for non-transactional `CREATE INDEX CONCURRENTLY`.
- **Effort:** S · **Risk of fixing:** low · **Verification:** a test migration with `pg_sleep(35)` applies.
- *Evidence:* read · *Status:* Batch 4 (migration runner — approval)

**BE-16** — **Severity:** medium
- **Location:** `src/lib/ml.ts:522` (`DELETE FROM asset_faces WHERE asset_id=$1` then re-insert), `src/lib/people.ts:181` (re-match by centroid).
- **Problem / Impact:** a manual "these are not her" correction reverts after any regenerate or forced ML backfill — curation lost silently.
- **Fix:** persist per-face overrides (asset, bbox → person) and re-apply after re-insert. **Effort:** M · **Risk:** medium · **Verification:** reassign a face, regenerate the asset: the assignment holds.
- *Evidence:* sweep · *Status:* Decision D14

**BE-17** — **Severity:** low
- **Location:** `src/lib/indexer.ts:188, 195` (two queries per walked file, unchanged ones included), `:189` (every walked session marked touched → hourly reconcile of all sessions).
- **Problem / Impact:** ~200k queries per hourly rescan at 100k assets, and three reconcile scans per session per hour (mechanism; not measured on the NAS).
- **Fix:** per-directory prefetch of `(abs_path, id, size, mtime)`; mark a session touched only on insert/update. **Measure first.**
- **Effort:** M · **Risk:** medium · **Verification:** query count per rescan from `pg_stat_statements`.
- *Evidence:* sweep · *Status:* Batch 6

**BE-18** — **Severity:** low
- **Location:** `duplicate_hits.content_hash` (no index; `duplicates.ts:387, 522` and the sweep's self-join), `people.cover_face_id` (FK with no index: every face delete seq-scans `people`), `abs_path LIKE 'prefix/%'` (`filter.ts:541`, `api/tree/fs/route.ts:80`; the UNIQUE btree cannot serve it under a non-C collation).
- **Fix:** `CREATE INDEX` on `duplicate_hits(content_hash)`, partial on `people(cover_face_id)`, `assets(abs_path text_pattern_ops) WHERE deleted_at IS NULL` — after an `EXPLAIN` on the real library.
- **Effort:** S · **Risk:** low · **Verification:** `EXPLAIN` before/after on the three queries.
- *Evidence:* sweep · *Status:* Batch 6 (migration — approval)

**BE-19** — **Severity:** low
- **Location:** `src/app/api/assets/calendar/route.ts:34, 68-75` (bounds over the whole library with `collapseGroups`, no `jit = off`).
- **Problem / Impact:** the known JIT trap (`docs/memory/database.md`: ~1 s at 87k) on every month change. **Fix:** compute bounds without `collapseGroups` (it cannot change min/max). **Effort:** S · **Risk:** low · **Verification:** `EXPLAIN ANALYZE` shows no JIT.
- *Evidence:* sweep · *Status:* Batch 6

**BE-20** — **Severity:** low
- **Location:** `src/lib/assetQuery.ts:20` (`GRID_SELECT` uses `a.*`), `src/lib/db.ts:14` (int8 → Number).
- **Problem / Impact:** every grid row carries `phash` rounded through a double (review D10 is reached, not theoretical); `types.ts` declares it a string. **Fix:** exclude it or select `phash::text`. **Effort:** S · **Risk:** low · **Verification:** a grid row's `phash` equals `SELECT phash::text`.
- *Evidence:* sweep · *Status:* Batch 8

**BE-21** — **Severity:** low
- **Location:** `/api/people` (all people + centroids), `duplicateList.ts:54-65` (whole `duplicate_hits` loaded, paged in JS), `purge.ts:64` (`a.*` for the whole trash), `/api/assets/[id]/similar:62-67` (scan per viewer open), `filter.ts:494-505` (`near_dup` O(n²) per session).
- **Fix:** paginate in SQL; for `similar`, a pre-filter or a cached neighbour list. **Effort:** M · **Risk:** low · **Verification:** row counts returned bounded by the page size.
- *Evidence:* sweep · *Status:* Batch 6

**BE-22** — **Severity:** low
- **Location:** `src/lib/pairing.ts:44-62, 103-121`, `src/lib/bursts.ts:96-111` (review R7, still true), racing the indexer via `api/sessions/[id]/restack`.
- **Fix:** `tx()` + `pg_advisory_xact_lock(hashtext('session:'||id))`. **Effort:** S · **Risk:** low · **Verification:** concurrent restack + reconcile leave no orphan groups.
- *Evidence:* sweep · *Status:* Batch 3

**BE-23** — **Severity:** low
- **Location:** `src/lib/video.ts:38-47` (an ffmpeg probe failure is cached for the process lifetime).
- **Problem / Impact:** one transient spawn failure marks every video `derivative_status='error'` ("ffmpeg not found") until a restart. **Fix:** cache only success, or re-probe after a TTL. **Effort:** S · **Risk:** low · **Verification:** unit test with a probe that fails once.
- *Evidence:* sweep · *Status:* Batch 3

**BE-24** — **Severity:** low
- **Location:** `src/lib/failures.ts:142` (`resolveScanFailure`, called nowhere).
- **Problem / Impact:** a file that failed once and later indexes stays listed as failed. **Fix:** call it on the indexer's success path. **Effort:** S · **Risk:** low · **Verification:** fail a file, fix it, rescan: it leaves the list.
- *Evidence:* sweep · *Status:* Batch 3

**BE-25** — **Severity:** low
- **Location:** `src/lib/db.ts:21-36` (no `pool.on("error")`).
- **Problem / Impact:** reproduced — terminating an idle pooled connection **kills a plain Node process** (unhandled `'error'`), so CLI scripts and `migrate` die on a Postgres restart; the app survives (Next logs it — checked against `next start`) and the worker survives through its keep-alive handler, so there it is log noise mislabelled as a crash. **Fix:** a one-line listener that logs. **Effort:** S · **Risk:** low · **Verification:** the same `pg_terminate_backend` script stays alive.
- *Evidence:* reproduced · *Status:* Batch 3

**BE-26** — **Severity:** low
- **Location:** `src/lib/people.ts:138-143` (every ML job with faces loads every person's centroid JSON).
- **Problem / Impact:** ~8 KB × people per job, serialized under the people advisory lock — fine today, linear in people. **Fix:** cache keyed on `(count, max(updated_at))`, as `suggestMerges` already does. **Effort:** S · **Risk:** low · **Verification:** job time flat as people grow.
- *Evidence:* sweep · *Status:* Batch 6

*Still open from `ARCHITECTURE-REVIEW.md`, re-checked:* **C8** (`settings.ts:94-97` still falls back to defaults on a DB error), **R5** (`video.ts:125` still `readFile`s the whole proxy), **R8** (no `lockDuration`, no `stop_grace_period`). *Corrected:* **D5** — `asset_faces.embedding` is no longer write-only (`people.ts:184, 216, 339` read it). *Checked and fine:* keyset pagination with a capped page on `/api/assets` and the session grid; the gallery's plans on 100k rows (2–9 ms, `assets_live_captured_idx` / `assets_session_captured_idx`); `tx()` releases its client; people merge/reassign are transactional under an advisory lock; ratings and tag assignment are upserts; the `app_documents` etag is checked inside the `UPDATE`.

### 2.F UX

Items already in `docs/UI-REVIEW.md` / `docs/SETTINGS-UI.md` (confirm dialogs
C10/C11, colour semantics T5/T6, hand-rolled menus C4, the Timeline delete
without a confirm) are not repeated.

**UX-01** — **Severity:** high
- **Location:** `GalleryShell.tsx:545-557` (`await fetch(…/rating)` never checked), `:566`; `SessionGrid.tsx:371`; `TimelinePanel.tsx:265`; `SiftSession.tsx:142, 160`; `lib/assetActions.ts:13, 106, 121, 136`. No `401` handling anywhere in `src/app`.
- **Problem:** verdicts, stars, tags and trash are optimistic and fire-and-forget: the UI updates first and nothing checks the response, rolls back or tells the user; pick-then-undo sends two unordered PATCHes.
- **Impact:** a culling session on flaky 4G, after a password reset (sessions revoked), or during a deploy looks saved and is not — the user's judgement, the product's whole output, silently lost.
- **Fix:** route every cull write through `mutate()` (SHR-01): revert and show a notice on failure, serialise writes per asset, send a 401 to `/login?next=`.
- **Effort:** M · **Risk of fixing:** low
- **Verification:** make the rating route return 500 (or revoke the session) and rate: the tile reverts, a notice says why.
- *Evidence:* read · *Status:* Batch 5

**UX-02** — **Severity:** high
- **Location:** `src/app/people/PersonPicker.tsx:199-205` → `PeoplePanel.tsx:830-836`.
- **Problem:** tapping a row in the merge picker merges at once — no confirmation, no undo; the row's largest area is a nested "view profile" link, so a near-miss merges.
- **Impact:** a mis-tap while scrolling on a phone merges two people; the repair is reassigning faces one by one.
- **Fix:** a row selects the target; a "Merge A into B" confirm (or a timed Undo) performs it.
- **Effort:** S · **Risk of fixing:** low · **Verification:** one tap no longer merges; the confirm names both people.
- *Evidence:* sweep · *Status:* Batch 5

**UX-03** — **Severity:** medium
- **Location:** `src/app/sessions/DeleteSessionModal.tsx:42, 66-79` vs `TrashTab.tsx:365` (`ConfirmDialog … requireAck`).
- **Problem / Impact:** deleting a session's originals from disk — picks included — takes one checkbox and one click, the weakest gate of any destructive action; the backdrop closes the modal while the delete runs.
- **Fix:** `requireAck`, the pick count in the warning, no dismissal while busy. (SEC-04 also moves the verb to admin.)
- **Effort:** S · **Risk:** low · **Verification:** the delete button stays disabled until the acknowledgement is ticked.
- *Evidence:* sweep · *Status:* Batch 5

**UX-04** — **Severity:** medium
- **Location:** `src/app/settings/volumes/VolumesPanel.tsx:179-186` (`onChange={(e) => changeType(…)}`).
- **Problem / Impact:** a volume's type changes the moment the select changes: Final → Incoming makes finished masters cullable and deletable; → Export un-indexes them; a failure snaps back silently.
- **Fix:** confirm the change, naming its consequence. **Effort:** S · **Risk:** low · **Verification:** changing the select opens a confirm; cancel leaves the type.
- *Evidence:* sweep · *Status:* Batch 5

**UX-05** — **Severity:** medium
- **Location:** `VolumesPanel.tsx:61-73, 78, 100` (no `r.ok` check), `SessionGrid.tsx:772` / `SessionsPane.tsx:428` ("Ignored" whatever the answer), `people/[id]/PersonDetail.tsx:212`, `AppRail.tsx:107-130` (if `/api/auth/me` fails, the account chip — the only way to Settings, Users and Sign out — disappears).
- **Problem / Impact:** mutations that fail silently; navigation that vanishes on one failed request.
- **Fix:** `mutate()` + a notice; render the account chip in an error state with a retry. **Effort:** S · **Risk:** low · **Verification:** each action with the route returning 500 shows a notice.
- *Evidence:* sweep · *Status:* Batch 5

**UX-06** — **Severity:** medium
- **Location:** `src/app/MediaViewer.tsx` (no `pushState`/`popstate` anywhere).
- **Problem / Impact:** the full-screen viewer has no history entry, so the Android back gesture leaves the page instead of closing the viewer — losing scroll position and selection, the cost `docs/memory/frontend.md` says the maintainer cares about.
- **Fix:** push a history entry on open, close on `popstate`. **Effort:** M · **Risk:** medium (interacts with the URL-state pages) · **Verification:** open, press back: viewer closes, grid unchanged.
- *Evidence:* sweep · *Status:* Batch 5

**UX-07** — **Severity:** low
- **Location:** `src/app/users/tokens/TokensPanel.tsx:409-413` (`useOverlayDismiss(onClose)` on the once-only token modal).
- **Problem / Impact:** a stray tap on the backdrop loses the only display of a new token's secret. **Fix:** no backdrop dismissal on that modal. **Effort:** S · **Risk:** low · **Verification:** backdrop tap leaves it open.
- *Evidence:* sweep · *Status:* Batch 5

**UX-08** — **Severity:** low
- **Location:** state not in the URL: session verdict filter (`SessionGrid.tsx:203`), Incoming sort/progress (`IncomingTab.tsx:44-46`), People query (`PeoplePanel.tsx:367`), Gear sort (`GearPanel.tsx:116`), Devices sort/facet (`DeviceAttribution.tsx:133-134`).
- **Problem / Impact:** reload and back lose the view; links cannot share it. **Fix:** the `searchParams` pattern the Gallery already uses, as each page is touched. **Effort:** S each · **Risk:** low · **Verification:** reload keeps the view.
- *Evidence:* sweep · *Status:* Batch 5

**UX-09** — **Severity:** low
- **Location:** `VolumesPanel.tsx:464` (Enter submits twice — `blocked` excludes `busy`), `ImportPanel.tsx:382` (offload path: placeholder, no label), `invite/[token]/InviteForm.tsx:118-141` (no `autocomplete="username"` field, so password managers save a password without its account).
- **Fix:** include `busy`; a label; a hidden read-only username field. **Effort:** S · **Risk:** low · **Verification:** double Enter posts once; a password manager offers to save "user + password".
- *Evidence:* sweep · *Status:* Batch 5

*Checked and fine:* double-submit protection on login, invite, change password, invite user, create token; correct `autocomplete` values; empty and error states on the main panes (Trash, Exports, Calendar, Heatmap, Unplaced, Features, Sift hub, Search, People).

### 2.G Accessibility (target WCAG 2.2 AA)

**A11Y-01** — **Severity:** high
- **Location:** `src/app/gallery/VirtualGrid.tsx:148-157` (`<div className="cell" onClick=…>`), `src/app/sessions/[id]/SessionGrid.tsx:1003-1015`.
- **Problem:** the tile — the app's primary object — is a `div` with a click handler: no role, no `tabIndex`, no key handler.
- **Impact:** keyboard and screen-reader users cannot open a single photo in Gallery, Incoming, Search, Person, Pipeline media or a session (WCAG 2.1.1, 4.1.2).
- **Fix:** render the tile as a `<button>` (Enter opens; Space toggles in select mode), or a grid with roving `tabIndex`; keep the `memo` boundary.
- **Effort:** M · **Risk of fixing:** medium (virtualised focus must survive scrolling)
- **Verification:** Tab reaches a tile, Enter opens the viewer, Escape returns focus to that tile; axe reports no `click-events-have-key-events` on the grid.
- *Evidence:* read · *Status:* Batch 7

**A11Y-02** — **Severity:** high
- **Location:** `src/app/ActionMenu.tsx:82-110` (portalled `role="menu"`, focus never moves in, no arrow keys); same gaps in `AppRail.tsx:157` (account popover), `PeoplePanel.tsx:296`, `ViewerActions.tsx:139`.
- **Problem / Impact:** the "⋯" menus — Delete, Export, Geotag, Download — and the account popover (Settings, Users, Sign out) are unreachable by keyboard.
- **Fix:** reuse `OptionPicker.tsx:201-228`'s listbox keyboard handling: focus the first item when placed, ↑/↓/Home/End, Escape returns focus to the trigger.
- **Effort:** S · **Risk:** low · **Verification:** keyboard-only: open a session menu and run Export.
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-03** — **Severity:** high
- **Location:** `src/app/sift/SwipeDeck.tsx:239-258` (only `INPUT`/`TEXTAREA` are exempt; Space → `commit("up")`, Enter → `openPeek()`, both `preventDefault`).
- **Problem / Impact:** Space on the focused **Pick** button *skips* the card; Enter on any focused button or rail link opens the peek viewer and cancels the click or navigation.
- **Fix:** return early when the event target is interactive (`button, a, select, [role], [tabindex]`) or a modifier is held.
- **Effort:** S · **Risk:** low · **Verification:** Tab to Pick, Space: the card is picked.
- *Evidence:* read · *Status:* Batch 7

**A11Y-04** — **Severity:** high
- **Location:** every modal (18 listed by the sweep: `ui.tsx:303 ConfirmDialog`, `DeleteSessionModal:42`, `UsersPanel:366, 463`, `TokensPanel:316, 412`, `MissingSection:357`, `DedupModals:46`, …); nothing in `src/app` traps Tab, uses `inert` or restores focus; 10 have no Escape.
- **Problem / Impact:** focus stays behind the dialog; Tab walks the page underneath; closing drops focus to `<body>` (WCAG 2.4.3, 2.4.11).
- **Fix:** one `useDialog` hook inside `<Modal>` (SHR-06). **Effort:** M · **Risk:** low · **Verification:** for each converted dialog: focus moves in, Tab cycles inside, Escape closes, focus returns to the trigger.
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-05** — **Severity:** medium
- **Location:** `src/app/MediaViewer.tsx:913-914` (`<div className="viewer">`, portalled at `:1523`), key handler `:518-531`.
- **Problem / Impact:** the viewer is not a dialog (no role or name, focus never moves in), and its keys ignore modifiers — Ctrl/Cmd+P marks a *pick* and opens the print dialog; Alt+← both steps and navigates back. Gestures do have button equivalents.
- **Fix:** `role="dialog" aria-modal aria-label`, focus in/out via `useDialog`, ignore events with a modifier. **Effort:** S · **Risk:** low · **Verification:** Ctrl+P in the viewer changes no verdict.
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-06** — **Severity:** medium
- **Location:** `src/app/layout.tsx:122-125` (`<div className="root-main">`); `<main>` only in `GalleryShell.tsx:943` and `CalendarView.tsx:179`.
- **Problem / Impact:** no skip link and no main landmark on most pages: every page starts with up to 9 rail stops. **Fix:** `<main id="main">` in the layout + a skip link. **Effort:** S · **Risk:** low · **Verification:** first Tab shows "Skip to content".
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-07** — **Severity:** medium
- **Location:** `src/app/layout.tsx:70` (`maximumScale: 1`).
- **Problem / Impact:** pinch-zoom is disabled app-wide on Android Chrome (iOS ignores it) — WCAG 1.4.4. **Fix:** remove it; the viewer already owns its pinch with `touch-action: none`. **Effort:** S · **Risk:** low (check the deck/viewer gestures on a phone) · **Verification:** pinch zooms a settings page; the viewer pinch still zooms the photo only.
- *Evidence:* read · *Status:* Batch 7

**A11Y-08** — **Severity:** medium
- **Location:** `gallery/FilterPanel.tsx:446-455` (17 chip toggles, 3 with `aria-pressed`), plus `SearchPage:378`, `TimelinePanel:307, 362`, `PipelineAssetList:708`, `DeviceAttribution:327, 337`, `FacesText:217`, `Tree:139`, `SearchIndex:222`.
- **Problem / Impact:** a chip's on/off state is colour only, and invisible to screen readers (WCAG 1.4.1, 4.1.2). **Fix:** `aria-pressed` + a non-colour cue (check glyph). **Effort:** S · **Risk:** low · **Verification:** axe clean; VoiceOver reads "pressed".
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-09** — **Severity:** medium
- **Location:** `ControlPanel.tsx:326-337` (6 sliders; the label is a sibling), tag inputs `ViewerActions.tsx:152`, `BulkActionBar.tsx:258`, `AssetActionMenu.tsx:182`, `FilterPanel.tsx:261, 803, 810`, `DuplicatesFailures.tsx:411`, `ImportPanel.tsx:382`, `VolumesPanel.tsx:179, 469`, rename inputs `PeoplePanel.tsx:260`, `PersonDetail.tsx:257`.
- **Problem / Impact:** controls with no programmatic label (WCAG 1.3.1, 4.1.2). **Fix:** `htmlFor`/`aria-label`; a fieldset/legend for the volume type. **Effort:** S · **Risk:** low · **Verification:** axe `label` rule clean on those pages.
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-10** — **Severity:** low
- **Location:** notices `GalleryShell.tsx:1145`, `SessionGrid.tsx:895`, `TrashTab.tsx:205`, `SessionsPane.tsx:522`, `UnplacedPane.tsx:536` (no live region, cleared after 3.5–6 s); `LoginForm.tsx:167`, `InviteForm.tsx:144` (errors without `role="alert"`).
- **Fix:** one polite live region for notices; `role="alert"` on form errors. **Effort:** S · **Risk:** low · **Verification:** a screen reader announces "Moved 3 to Trash".
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-11** — **Severity:** low
- **Location:** 9 icon-only buttons named by `title` alone (`IncomingTab:127, 135`, `ViewerActions:111`, `BulkActionBar:227`, `AssetActionMenu:106, 115`, `TrashTab:286`, `MediaViewer:1211`, `SuggestionsModal:159`); the tag-remove `×` at `GalleryShell.tsx:1324` has no name; `Spinner` is `aria-hidden` (`ui.tsx:164`), so ~10 buttons lose their name while busy.
- **Fix:** `aria-label`s; keep the label text in busy buttons. **Effort:** S · **Risk:** low · **Verification:** axe `button-name` clean.
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-12** — **Severity:** low
- **Location:** `PersonPicker.tsx:196-210` (`role="link"` inside a `<button>`), `ChapterEditModal.tsx:310` (`role="listbox"` without options), `LocationPicker.tsx:248-262` (arrow-key highlight without combobox roles).
- **Fix:** un-nest the link; `role="option"`; `role="combobox"` + `aria-expanded` + `aria-activedescendant`. **Effort:** S · **Risk:** low · **Verification:** axe `nested-interactive`, `aria-required-children` clean.
- *Evidence:* sweep · *Status:* Batch 7

**A11Y-13** — **Severity:** low
- **Location:** `globals.css:183` (`scroll-behavior: smooth` not reset under `prefers-reduced-motion`), `TimelinePanel.tsx:299` (`behavior: "smooth"`); `SessionGrid.tsx:1041-1043` (skip shown as "✕", the same glyph as reject — only colour differs).
- **Fix:** reset under reduced motion; use "↪" as `VirtualGrid.tsx:212` does. **Effort:** S · **Risk:** low · **Verification:** OS reduced-motion → instant scroll; a skip reads differently from a reject in greyscale.
- *Evidence:* sweep · *Status:* Batch 7

**Automated checks to add, and their limits.** (1) `@axe-core/playwright` over ~10 key routes against a seeded database, as a CI job — Playwright is already in this environment, not in the repo, so it would be a new devDependency; (2) `eslint-plugin-jsx-a11y` only if ESLint is adopted (DX-02). Automation catches names, roles, labels, contrast of static text and nesting; it **cannot** catch focus order and restoration, keyboard traps, the Sift key hijack (A11Y-03), whether a gesture has an equivalent, or whether an announcement makes sense — those need the manual keyboard + VoiceOver/TalkBack pass this audit describes per finding.

*Checked and fine:* `lang="en"` and per-route titles; `OptionPicker` (listbox with full keyboard) and `RangeSlider` (`aria-valuetext`, commits on keyup/blur); `nav` + `aria-current` on the section tabs; the rail's labelled `nav`; animations and transitions zeroed under reduced motion; `:focus-visible` replaced by visible rings where outlines are removed; every swipe has a button equivalent.

### 2.H Scalability, extensibility, operability

**SCL-01** — **Severity:** high
- **Location:** `docker-compose-optiplex.yml:210-221` (`migrate`: one-shot, `restart: "no"`, no Watchtower label), `:267`, `:354` (the label is on `app` and `worker` only); no code path migrates at boot.
- **Problem:** Watchtower recreates the labelled, running containers; an exited, unlabelled one-shot is not re-run (unless Watchtower runs with `--include-stopped --revive-stopped`, §1.7), and `depends_on: service_completed_successfully` is only evaluated by `docker compose up`.
- **Impact:** a merge that carries a migration goes live against the old schema: 500s on the new columns, worker jobs burning their three attempts — until someone redeploys the stack by hand, which `MEMORY.md` says is exactly what must never be required.
- **Fix:** the worker runs `migrate()` before creating its Workers, under a `pg_advisory_lock` (closing review D8 too); the app's health answers "schema behind" until `schema_migrations` is current.
- **Effort:** S · **Risk of fixing:** medium (deploy path)
- **Verification:** deploy an image carrying a no-op migration through Watchtower: `schema_migrations` gains the row without a manual step.
- *Evidence:* read (Watchtower flags unverified) · *Status:* Decision D6 → Batch 4

**SCL-02** — **Severity:** medium
- **Location:** `.github/workflows/docker-build.yml:3-6` (`on: push: main`, no `needs`, no `concurrency`, no `paths-ignore`).
- **Problem:** the image is built and deployed whether or not `ci.yml` passes (migrations are never validated before deploy); two quick merges race and the older build can move `main`/`latest` last; a docs-only push redeploys production, SIGKILLing long transcodes (review R8).
- **Fix:** trigger on `workflow_run` of CI with `conclusion == success` (or one workflow with `needs:`), `concurrency: { group: docker-main }`, the same `paths-ignore`.
- **Effort:** S · **Risk of fixing:** low · **Verification:** a red CI on `main` publishes no image.
- *Evidence:* read · *Status:* Decision D7 → Batch 4

**SCL-03** — **Severity:** medium
- **Location:** `src/app/api/health/route.ts:9-24` (503 when Postgres or Redis is down), `Dockerfile:77-78` (the container HEALTHCHECK uses it).
- **Problem:** the liveness probe is a dependency probe; a Postgres restart or a saturated pool marks the app container *unhealthy*. Traefik's Docker provider stops routing to unhealthy containers (from Traefik's documented behaviour; not verified on this stack, §1.7), and nothing restarts it.
- **Impact:** a database blip becomes a site-wide 404/502 instead of the "status pill, never a takeover" `ConnectionStatus` was built for.
- **Fix:** a liveness-only probe for Docker (`/api/health` answers 200 when the process serves), dependency detail at `/api/health?deep=1` for the UI pill.
- **Effort:** S · **Risk of fixing:** low · **Verification:** stop Postgres: the page still loads with the "database is down" pill.
- *Evidence:* read · *Status:* Batch 4

**SCL-04** — **Severity:** low
- **Location:** in-process state: login throttle (`auth.ts:403`), auth cache (`auth.ts:202`, 10 s), settings and feature caches (1.5 s, per bundle), backup `dumping` flag (`api/db/backup/route.ts:26`), `lastTouch` map (`auth.ts:207`, never pruned).
- **Problem / Impact:** correct for the one app container the deployment runs; with two, revocation lags ≤ 10 s, throttles multiply, two dumps can run. `lastTouch` grows by one entry per session ever seen.
- **Fix:** none now (single instance by design); prune `lastTouch` with the cache. Move throttles to Redis only if a second instance is ever planned.
- **Effort:** S · **Risk:** low · **Verification:** n/a.
- *Evidence:* sweep · *Status:* Won't now (§3.3)

**SCL-05** — **Severity:** low
- **Location:** no request/correlation id anywhere; no `logging:` limits in compose; backup sidecar (`docker-compose-optiplex.yml:170-172`) ignores `gzip`/`mv` exit codes and never `gzip -t`s (unlike `scripts/pg-backup.sh`); `node:22-slim`, `postgres:16-alpine`, `redis:7-alpine` and Actions pinned by tag; `.dockerignore` misses `backups/`, `.env.*`, `*.pem`, `dump.rdb`, `nas-*`; `src/lib/storage/s3.ts:20-28` has no request timeout.
- **Problem / Impact:** a 500 cannot be tied to its log line; logs grow unbounded on the host; a corrupt nightly dump goes unnoticed until a restore; a local `docker build` can bake dumps (password hashes) into a layer; a hung MinIO hangs derivative jobs.
- **Fix:** log `{ref, method, path, user, cf-ray}` in `serverError`; `logging: json-file max-size 20m max-file 5`; reuse `pg-backup.sh` in the sidecar; mirror `.gitignore` in `.dockerignore`; `NodeHttpHandler` timeouts; digest-pin via Renovate later.
- **Effort:** S each · **Risk:** low · **Verification:** per item.
- *Evidence:* sweep · *Status:* Batch 4

**SCL-06 — planned features: what each would touch today.** From `MEMORY.md`'s open items and `docs/SETTINGS-UI.md`.

| Planned work | Files that change today | Acceptable? | Seam that makes it local |
|---|---|---|---|
| Quiet hours (E19) | `settings.ts` ×4, `api/settings`, `ControlPanel.tsx`, `worker.ts` ×3, `ml.ts`, `geocode.ts` | **No** — 5 pacing sites | `pace(stage)` in `lib/rate.ts` (ARC-03) |
| Trash retention (E20) | `purge.ts`, worker tick, `settings.ts`, a Settings control | Yes | the purge job already exists |
| Import filing template (E21) | `import.ts:76 planDestination`, config/settings, UI | Yes — one function | none needed |
| Notifications (E23) | every job's completion/failure site | **No** | one `onJobFinished(name, job, result|err)` hook on the existing `worker.on("failed")` loop (`worker.ts:274`), plus a failure-kind registry (ARC-06) |
| Embedded `djmd` re-read (`-ee`) | `extract.ts`, `indexer.ts`, `deviceAttribution.ts`, an enqueue-only pass | Yes | the relink/integrity "job name on a shared queue" pattern |
| Move detection (`st.dev, st.ino`) | migration, `indexer.ts` collision branch, `relink.ts` | Yes | the indexer is already the hub |
| Purge releases `content_hash` | `purge.ts` step 3 | Yes — one statement | — (a decision, not a seam) |
| Heatmap zoom bins | `lib/heat.ts` | Yes | — |
| Timeline rework | `lib/timeline.ts` (696 lines, SQL + pure algorithms) | Borderline | split the pure core first — it is the test seam |
| Disk-space preflight (R4) | `export.ts`, `import.ts`, `derivatives.ts` | Yes | an `ensureFreeSpace(dir, bytes)` helper, 3 callers |
| Job cancel (C4) | each long job body | Yes | the indexer's `shouldStop` pattern generalised |
| Settings rail by decider (D15) | `settings/**` UI | Yes | UI only |
| More than one app instance | SCL-04 list | Not planned | — |

**Data growth, tenancy, i18n, theming.** Pagination is keyset on the big reads (`/api/assets`, session grid); the unbounded ones are BE-06 and BE-21. Retention is review D7 (unchanged). Multi-tenancy and i18n are not plausible for this product (`docs/memory/frontend.md`: no i18n layer planned) — nothing cheap to do now. Theming is already tokenised (light/night), which is the door kept open. **Contracts:** `/api/capabilities` is the versioned contract with Atelier (`API_VERSION`, add-never-rename); request/response types are not shared between client and server (DX-06). **Cost:** nothing here scales in price — it is one box; the costs that scale are HDD time (re-reads: SEC-01, BE-03's second read, BE-17) and Postgres write amplification (BE-14).

### 2.I Testing, types, developer experience

**DX-01** — **Severity:** high
- **Location:** repository-wide — no test runner, no `npm test`, no test file (`docs/memory/testing-and-ci.md`).
- **Problem:** the four data-loss paths found here (SEC-01, BE-01, BE-02, BE-03) are each a small function a test would have pinned; every refactor rides on `tsc` alone.
- **Impact:** a fix to any of them can regress silently.
- **Fix:** `node:test` run by the `tsx` already in `dependencies` (`npm test`, co-located `*.test.ts`) — no new package. Unit tests need nothing; DB-backed tests use `DATABASE_URL` and skip, saying so, when Postgres is unreachable. A CI job is a separate, approved step.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** `npm test` runs the batch-1 regression tests green, and each test fails against the pre-fix code.
- *Evidence:* read · *Status:* **Fixed (batch 1)** (runner + first tests); CI job → Decision D8

**DX-02** — **Severity:** medium
- **Location:** no ESLint; 45 `eslint-disable` comments in `src/app`, 16 of them `react-hooks/exhaustive-deps`.
- **Problem / Impact:** hook dependency arrays are checked by nothing — FE-01's stale reset lives in exactly such an effect.
- **Fix:** a minimal flat config with `eslint-plugin-react-hooks` (+ `jsx-a11y`), not a style ruleset. New devDependencies (`eslint`, two plugins, all actively maintained, dev-only, zero runtime/bundle cost); the alternative — hand-review of every effect — is what produced FE-01.
- **Effort:** M · **Risk of fixing:** low (findings, not rewrites) · **Verification:** `npx eslint src` clean after fixing what it reports.
- *Evidence:* read · *Status:* Decision D9

**DX-03** — **Severity:** medium
- **Location:** `src/lib/lensLabels.ts:116, 127` (literal NUL bytes as a sentinel: `"\0unknown"` written raw).
- **Problem:** git, `grep` and ripgrep treat the file as **binary**: `git log --numstat` prints `- -`, PR diffs show "Binary files differ", `rg` skips it silently.
- **Impact:** every review of that file and every search of the tree misses it — the agents' and the maintainer's.
- **Fix:** write the escape `"\u0000"` instead of the byte; the string value is identical.
- **Effort:** S · **Risk of fixing:** low
- **Verification:** reproduced (before): `git log -1 --numstat -- src/lib/lensLabels.ts` → `-	-`; `grep -a -nP "\x00"` finds lines 116 and 127. After: numstat shows line counts; `tsc` and behaviour unchanged.
- *Evidence:* reproduced · *Status:* Batch 8

**DX-04** — **Severity:** low
- **Location:** `tsconfig.json` (`strict: true`).
- **Problem / Impact:** the cheap extra flags are off: `noUnusedLocals`/`noUnusedParameters` (5 errors today), `noImplicitReturns`, `noFallthroughCasesInSwitch` (1). `noUncheckedIndexedAccess` would raise 203 — not worth it now.
- **Fix:** enable the cheap flags, fix the 6 errors. **Effort:** S · **Risk:** low · **Verification:** `npm run typecheck` green with them on.
- *Evidence:* sweep · *Status:* Batch 8

**DX-05** — **Severity:** low
- **Location:** `docs/ARCHITECTURE-REVIEW.md:144-146` (sizes), `docs/memory/configuration.md` ("nine `AppSettings` keys" — there are ten: `gpsWritePerHour`), ARC-07's comments.
- **Problem / Impact:** the design record drifts from the code it describes. **Fix:** correct them. **Effort:** S · **Risk:** low · **Verification:** re-read.
- *Evidence:* read · *Status:* Batch 8

**DX-06** — **Severity:** low
- **Location:** 73 `fetchJson<T>` calls (unchecked casts), 12 untyped `r.json()`, duplicated declarations already drifting (`useStats.ts:10` vs `queue.ts:300`; `failures/model.ts:78` vs `relink.ts:75`).
- **Problem / Impact:** a renamed response field type-checks on both sides and breaks at runtime. **Fix:** shared response types in `*Types.ts` files, imported by both sides, as each route is touched. **Effort:** M · **Risk:** low · **Verification:** `tsc` catches a deliberately renamed field.
- *Evidence:* sweep · *Status:* Batch 8

*Onboarding:* `README.md` + `CONTRIBUTING.md` get a new developer running in under ten minutes with Docker (checked: `npm ci` ~1 min, `migrate`, `build` 16 s); the only gap is `npm test`, documented in batch 1. *Decision records:* `ARCHITECTURE-REVIEW.md`, the briefs and `docs/memory/*` already serve as ADRs; no new format is proposed.

---

## 3. Plan (phase 2)

### 3.1 All findings, by impact ÷ effort

Impact: critical 4, high 3, medium 2, low 1. Effort: S 1, M 2. Ties keep
severity order. "Approval" marks what rule 7 of the brief (auth, migrations,
CI/deploy, data deletion, public contracts) reserves for the maintainer.

| # | ID | Sev. | Effort | Risk | Batch | Depends on / note |
|---|---|---|---|---|---|---|
| 1 | SEC-01 | critical | S | low | **1 ✓** | — |
| 2 | SEC-02 | critical | S | medium | **1 ✓** | — |
| 3 | DX-01 | high | S | low | **1 ✓** | first, so every later fix has a test |
| 4 | BE-01 | high | S | low | **1** | DX-01 |
| 5 | BE-03 | high | S | low | **1** | DX-01 |
| 6 | SEC-03 | high | S | medium | 2 | D1 · approval (auth) |
| 7 | SEC-04 | high | S | low | 2 | D3 · approval (auth, deletion) |
| 8 | SEC-05 | high | S | medium | 2 | D4 · approval (auth) |
| 9 | BE-05 | high | S | low | 3 | — |
| 10 | SCL-01 | high | S | medium | 4 | D6 · approval (deploy, migrations) |
| 11 | BE-09 | high | S/M | low | 5 (interim) | D2 for the real fix · approval (deletion) |
| 12 | FE-01 | high | S | low | 5 | — |
| 13 | UX-02 | high | S | low | 5 | — |
| 14 | A11Y-02 | high | S | low | 7 | — |
| 15 | A11Y-03 | high | S | low | 7 | — |
| 16 | SEC-06 | medium | S | low | 2 | approval (login flow) |
| 17 | SEC-08 | medium | S | low | 2 | approval (headers change framing) |
| 18 | SEC-07 | medium | S | medium | — | D11 (card mount paths) |
| 19 | ARC-04 | medium | S | low | 3 | — |
| 20 | BE-11 | medium | S | low | 3 | — |
| 21 | BE-13 | medium | S | low | 3 | — |
| 22 | BE-15 | medium | S | low | 4 | approval (migration runner); with SCL-01 |
| 23 | SCL-02 | medium | S | low | 4 | D7 · approval (CI) |
| 24 | SCL-03 | medium | S | low | 4 | approval (deploy) |
| 25 | FE-02 | medium | S | low | 6 | measured; pairs with BE-06 |
| 26 | FE-03 | medium | S | low | 5 | FE-01's pattern |
| 27 | UX-03 | medium | S | low | 5 | SEC-04 |
| 28 | UX-04 | medium | S | low | 5 | — |
| 29 | UX-05 | medium | S | low | 5 | SHR-01 |
| 30 | SHR-02 | medium | S | low | 8 | — |
| 31 | SHR-07 | medium | S | low | 7 | — |
| 32 | DX-03 | medium | S | low | 8 | — |
| 33 | A11Y-06 | medium | S | low | 7 | — |
| 34 | A11Y-07 | medium | S | low | 7 | phone check |
| 35 | A11Y-08 | medium | S | low | 7 | — |
| 36 | A11Y-09 | medium | S | low | 7 | — |
| 37 | A11Y-05 | medium | S | low | 7 | SHR-06 |
| 38 | BE-02 | high | M | low | **1** | DX-01 |
| 39 | BE-04 | high | M | medium | 6 | D5 · approval (internal API contract) |
| 40 | UX-01 | high | M | low | 5 | SHR-01 |
| 41 | A11Y-01 | high | M | medium | 7 | — |
| 42 | A11Y-04 | high | M | low | 7 | SHR-06 |
| 43 | SHR-01 | medium | M | low | 5 | — |
| 44 | ARC-01 | medium | M | medium | 9 | batches 1–3 (tests on each path first) |
| 45 | ARC-02 | medium | M | low | 8 | — |
| 46 | ARC-03 | medium | M | medium | 9 | with quiet hours (E19) |
| 47 | BE-06 | medium | M | medium | 6 | measured 830 ms |
| 48 | BE-07 | medium | M | medium | 3 | D10 · lineage key needs a migration (approval) |
| 49 | BE-08 | medium | M | low | 3 | — |
| 50 | BE-10 | medium | M | medium | 3 | — |
| 51 | BE-12 | medium | M | low | 3 | — |
| 52 | BE-14 | medium | M | medium | 6 | D12 (production `pg_stat` first) · approval (migration) |
| 53 | BE-16 | medium | M | medium | — | D14 · approval (schema) |
| 54 | FE-04 | medium | M | medium | 6 | FE-01 |
| 55 | UX-06 | medium | M | medium | 5 | — |
| 56 | DX-02 | medium | M | low | — | D9 (new devDependencies) |
| 57 | SEC-09 | low | M | medium | 8 | D15; UX-05 first (UI shows messages) |
| 58–92 | all **low / S**: SEC-10, SEC-11, SEC-12, SEC-13, ARC-05, ARC-07, SHR-03, SHR-04, SHR-05, SHR-08, SHR-09, FE-05, FE-07, FE-08, FE-09, FE-10, BE-18, BE-19, BE-20, BE-22, BE-23, BE-24, BE-25, BE-26, UX-07, UX-08, UX-09, A11Y-10, A11Y-11, A11Y-12, A11Y-13, DX-04, DX-05, SCL-04, SCL-05 | low | S | low | per §2 status | BE-18 needs a migration (approval); SCL-05 touches compose (approval) |
| 93–98 | **low / M**: ARC-06, SHR-06, FE-06, BE-17, BE-21, DX-06 | low | M | low–medium | per §2 status | FE-06, BE-17: measure first |

### 3.2 Batches

Each batch is independently shippable and revertable (one commit per
finding inside it), leaves the app working, and passes `typecheck`,
`migrate`, `build` and `npm test`. The order follows the brief's suggestion,
with two moves argued below.

1. **Batch 1 — stop the losses that need no decision** (executed with this document, §4): DX-01 harness, SEC-02, SEC-01, BE-01, BE-02, BE-03. Everything in it is a refusal or a bounds check added to a destructive path, a dependency patch, or a test — no auth, schema, CI or deploy change.
2. **Batch 2 — request and auth hardening** *(approval: auth)*: SEC-03 (D1), SEC-04 (D3), SEC-05 (D4), SEC-06, SEC-08, SEC-10, SEC-13. One theme — `proxy.ts`, `authz.ts`, login — so it is reviewed once.
3. **Batch 3 — pipeline integrity, no schema change**: BE-05, BE-11, BE-13, BE-12, BE-10, BE-22, BE-08, BE-23, BE-24, BE-25, ARC-04, SEC-12; BE-07 once D10 is answered.
4. **Batch 4 — deploy and CI guardrails** *(approval: CI/deploy/migration runner)*: SCL-01 (D6) + BE-15 together (one runner change), SCL-02 (D7), the `npm test` CI job (D8), SCL-03, SCL-05.
5. **Batch 5 — the cull must not lie**: SHR-01 → UX-01, FE-01, FE-03, FE-08, UX-02…09, BE-09's interim dialog. *Moved ahead of performance*: a verdict that silently fails to save is lost work, which is a correctness bug in this product, not polish.
6. **Batch 6 — performance, measured**: FE-02 + BE-06 (the 830 ms poll) first, then BE-04 (D5), FE-04, FE-05, FE-07, FE-09, BE-19, BE-21, BE-26, SEC-11; BE-14/BE-18 once production statistics exist (D12); FE-06 and BE-17 only after a measurement.
7. **Batch 7 — accessibility**: SHR-06 (`<Modal>`/`useDialog`) first, then A11Y-04/05, A11Y-01/02/03, the rest; SHR-07/08 tokens alongside.
8. **Batch 8 — shared code and hygiene**: SHR-02…05, SHR-09, ARC-02, ARC-05, ARC-07, DX-03…06, FE-10, BE-20, SEC-09 (D15).
9. **Batch 9 — seams, with the feature that needs them**: ARC-01 after batches 1–3 have put tests on each deletion path; ARC-03 with quiet hours. *Moved last on purpose*: a seam built before its second caller is the abstraction the brief warns against.

### 3.3 Recommended NOT doing

- **No ORM, repository layer, DI container, event bus or plugin system.** The `lib/` modules already are the application layer; the inline SQL that hurts is the duplicated SQL (ARC-02), and that moves into a function, not a framework.
- **No splitting of the 1,000+ line components for size alone.** Each one is cut only where a fix needs a seam (`useDialog`, `VirtualGrid` reuse, `mutate`).
- **No registries for export targets or queues** (ARC-06): no new variant is planned; the failure-kind registry waits for notifications.
- **No Redis-backed throttles, no shared caches across instances** (SCL-04): one app container by design.
- **No data descriptors in the ZIP writer**, and no `archiver` dependency: the current format was chosen for macOS Archive Utility compatibility and stays byte-identical; large entries are read twice instead.
- **No cache in front of `/api/stats`/`/api/facets`**: measured at 86–98 ms on 100k; stop the hidden-tab polling first, and there is no invalidation story worth its cost.
- **No index dropped from a synthetic measurement.** BE-14's numbers show the mechanism; the drop list comes from production `idx_scan`.
- **No `noUncheckedIndexedAccess`** (203 errors for little gain now), **no ESLint style rules** (hooks + a11y only, if D9 says yes).
- **No full CSP with nonces yet**: the pre-paint theme script would need a hash and every route would turn dynamic; `frame-ancestors`/`nosniff`/`Referrer-Policy` buy most of the value.
- **No chokidar watch on the NAS roots** for BE-08 — the memory already rejected it (inotify cost, misses moves made while down); the fix is in the inbox watcher only.
- **No blocking spinners instead of optimistic culling** (UX-01): keep it optimistic, add the revert.

### 3.4 Decisions for the maintainer

| # | Finding | Options | Recommendation |
|---|---|---|---|
| D1 | SEC-03 CSRF | (a) `Sec-Fetch-Site`/`Origin` check in `proxy.ts`; (b) require `Content-Type: application/json` on every mutation; (c) CSRF tokens | **(a)** — one place, no client change, Bearer clients unaffected; (b) is a fine second layer |
| D2 | BE-09 volume removal | (a) detach: hide sessions, keep rows, re-attach on re-add; (b) refuse while any rating/tag exists; (c) keep the cascade behind a typed confirmation naming the counts | **(b)** now (S), (a) when someone needs to move a library |
| D3 | SEC-04 session hard-delete | (a) admin-only and through the purge guards; (b) keep editor, add `PURGE_ENABLED` + `purge_log` | **(a)** — it is the purge verb under another name |
| D4 | SEC-05 login brake | key on `CF-Connecting-IP` vs last trusted hop; per-account cap: slow vs lock | `CF-Connecting-IP`, per-account **slow-down** (no lock-out). Needs Traefik's forwarded-headers config to confirm |
| D5 | BE-04 upload | (a) per-file streamed `PUT` (no dependency); (b) `busboy` streaming of the current multipart | **(a)** — no dependency, and each request stays under Cloudflare's body cap for photos (videos > 100 MB still need the LAN or a bigger plan) |
| D6 | SCL-01 migrations on deploy | (a) worker migrates at boot under an advisory lock; (b) label `migrate` + Watchtower `--revive-stopped` | **(a)** — survives any deploy tool |
| D7 | SCL-02 image build | (a) `workflow_run` after CI; (b) one workflow with `needs:` | **(a)** — smallest diff |
| D8 | DX-01 CI job | add `npm test` to the `build` job (it has Postgres) | **yes** |
| D9 | DX-02 linting | adopt ESLint for hooks + a11y only, or not | **yes**, dev-only, findings fixed in batch 7–8 |
| D10 | BE-07 export layout | suffix collisions `__N` (as the importer does) and add the job id to the folder name, or keep names and refuse collisions | suffix + job id; confirm Capture One's import is indifferent to folder names |
| D11 | SEC-07 offload paths | list the card mount(s) in `BROWSE_ROOTS`, then confine | needs the Optiplex's card mount path |
| D12 | BE-14 indexes | collect `pg_stat_user_indexes` for a week, then a migration | run `SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname='assets' ORDER BY idx_scan` on the Optiplex and send it |
| D13 | (open item) purge keeps `content_hash` | release it in `purge.ts` | **yes** — BE-01 and BE-02 are partly caused by it |
| D14 | BE-16 face corrections | persist per-face overrides | yes, small table |
| D15 | SEC-09 error messages | generic message + ref everywhere, typed errors for the user-fixable ones | yes, after UX-05 |

---

## 4. Batch 1 — execution record (phase 3)

*Each batch-1 finding lands as its own commit in the pull request that adds
this document, flipping its status in §2 to **Fixed (batch 1)** and adding
its line below: what changed, the verification actually run, and any
behaviour change.*

- **DX-01 — test runner.** `package.json` gains `"test": "tsx --test \"src/**/*.test.ts\""` — Node's built-in runner through the `tsx` already in `dependencies`, so no package is added (vitest/jest would each be a new dev dependency for what `node:test` does). First suite: `src/lib/authz.test.ts`, nine tests pinning the role policy as it is today (defaults, admin prefixes, self-service, segment-boundary matching, the public surface, token caps), so batch 2's auth changes start from a recorded baseline. `CONTRIBUTING.md`, `CLAUDE.md` and `docs/memory/testing-and-ci.md` stop saying there are no tests and document the opt-in for database-backed tests. *Verification:* `npm test` → 9 pass; `npm run typecheck` green. *Behaviour change:* none. *Not done:* the CI job (D8 — CI changes need approval).
- **SEC-02 — dependency advisories and the public optimizer.** `next` 16.2.12 → **16.3.8**, `sharp` 0.35.3 → **0.35.5** (dependency and override), `postcss` override floor 8.5.23 → 8.5.28 (pulls `nanoid` 3.3.19). The lockfile diff touches only `next`, `@next/*`, `@swc/helpers`, `sharp`, `@img/*`, `postcss`, `nanoid`. `next.config.mjs` sets `images: { unoptimized: true }`, with the reason in a comment. *Verification:* `npm audit` and `npm audit --omit=dev` → **0 vulnerabilities** (were 1 critical, 2 high); `/_next/image?url=/icons/icon-192.png` without a cookie → **404** (was 200 image/png); typecheck, `npm test`, `npm run build` green (155 dynamic routes, unchanged; the NFT-trace warning is the same one, now reported at two lines of `export.ts`); Playwright on `next start`: sign-in, `/library`, `/library/incoming/grid`, `/library/gallery`, `/sessions/5`, `/settings/pipeline`, `/settings/volumes`, `/users` all render with their headings, a rating PATCH from the page → 200, no page errors, no 5xx. *Behaviour change:* none visible — nothing used `next/image`. *Deploy note:* a framework minor bump; roll back by pinning the previous `sha-` image tag.
- **SEC-01 — export folders stay inside `EXPORT_DIR`.** `lib/export.ts`: `sanitize` turns a name made only of dots into underscores (every other name keeps its folder, so existing exports are still found); new `exportFolder(name)` is the single place the folder is computed and throws unless the result is a direct child of `EXPORT_DIR`; the copy (`copyToExportFolder`) and the delete (`api/exports/[id]`) both use it. *Verification:* `src/lib/export.test.ts` (14 hostile names incl. `.`, `..`, `../..`, `/etc`, `..\\..`, empty, NUL) — 3/3 pass; with the old `sanitize` body restored, 2/3 fail (`"." -> "."`). *Behaviour change:* an export named only with dots now uses a `__`-style folder; a pre-existing job whose stored name is dot-only no longer deletes `/data` or `EXPORT_DIR` — its folder removal reports an error in `file_errors` instead.

