# Winnow — Pipeline architecture review

*Reviewed at ~40k LOC, 33 migrations, 9 queues. This document is the reference
state-of-the-union for the ingest/analysis pipeline: what the design does well
(and must be preserved through refactors), where it is fragile, and a
prioritized roadmap. File references are to the tree at the time of review.*

---

## 1. System map

One **producer** (the Next.js app, which enqueues from API routes) and one
**consumer** (the worker container, `src/worker.ts`) communicate through
Postgres + a Redis/BullMQ queue set. The worker is a single Node process
hosting nine BullMQ workers:

| Queue | Handler | Concurrency (env) | Default |
|---|---|---|---|
| `winnow-index` | `lib/indexer.ts indexRoot` | `SCAN_CONCURRENCY` | 1 |
| `winnow-derivatives` | `lib/derivatives.ts` | `DERIVATIVE_CONCURRENCY` | 3 |
| `winnow-export` | `lib/export.ts` | `EXPORT_CONCURRENCY` | 2 |
| `winnow-import` | `lib/import.ts` | `IMPORT_CONCURRENCY` | 1 |
| `winnow-purge` | `lib/purge.ts` | `PURGE_CONCURRENCY` | 1 |
| `winnow-geocode` | `lib/geocode.ts` | `GEOCODE_CONCURRENCY` | 1 |
| `winnow-ml` | `lib/ml.ts` | `ML_CONCURRENCY` | 1 |
| `winnow-integrity` | `lib/integrity.ts` | hard-coded | 1 |
| `winnow-gpswrite` | `lib/exifWrite.ts` | hard-coded | 1 |

Orchestration is **manual chaining** — each stage enqueues the next from
inside its own job body (no BullMQ flows):

```
bootstrap / periodic tick (60 s) / inbox watcher / API
  └► index ──► per file: stat → skip-if-unchanged → partialHash → exiftool
        ├──► derivatives (thumb+proxy) ──► ml (faces + OCR + CLIP, one HTTP call)
        ├──► geocode (if GPS)                    to immich-machine-learning
        └► end of scan, per touched session:
             pairing (RAW+JPEG, Live Photos) → bursts → edits → missing-file
             reconciliation
```

ML inference is **remote HTTP** to an `immich-machine-learning` container
(`POST /predict`, one multipart call carrying faces + OCR + CLIP tasks).
Winnow embeds no models; two local metrics (Laplacian sharpness, 64-bit dHash)
are computed with sharp on bytes already in memory. Reverse geocoding is
Nominatim (public instance by default) behind a coordinate-cell cache
(`places`) that collapses ~90k geotagged assets to a few hundred calls.

Pacing is a shared Redis token-bucket (`lib/rate.ts`) with live-tunable
per-hour budgets in `app_settings` (`scanPerHour`, `analyzePerHour`,
`mlPerHour`, `geocodePerHour`); concurrency knobs are env/boot-time. Pause is
two-layer: BullMQ queue pause + a DB flag checked mid-job.

## 2. What is already good — preserve this

- **Worker memory hygiene** (the most deliberate part of the codebase):
  jemalloc + `MALLOC_ARENA_MAX=2`, `--max-old-space-size=1024`,
  `mem_limit`+`memswap_limit` set equal (no invisible swap), `sharp.cache(false)`
  + `SHARP_CONCURRENCY=1`, and HEIF decoding **out-of-process and serialized**
  (`lib/extract.ts`) so libheif's growing WASM heap is reclaimed per file.
- **Incremental scanning**: stat-gated (size+mtime) — a re-scan of an unchanged
  80k library hashes nothing and runs no exiftool. Partial hash (size + two
  64 KiB windows) with full-hash arbitration on collision, and an audit trail
  (`duplicate_hits`) for every dedup decision.
- **Config discipline**: every env var goes through one Zod schema
  (`lib/config.ts`) that fail-fasts at boot with an aggregated error;
  `.env.dist` documents everything.
- **Careful original-file handling**: NAS mounted RO, exports/imports copy via
  `.part` → verify → `rename`, purge has three guards + a mass-disappearance
  guard on missing-file reconciliation so an unmounted NAS flags instead of
  auto-trashing.
- **No SQL injection**: every dynamic SQL site builds `$n` placeholders;
  filters validated by Zod; LIKE escaped; facet column names are hardcoded.
- **One implementation per operation**: `lib/*` owns logic; worker, API routes
  and CLI scripts are thin wrappers around the same functions.
- **Design-rationale comments** throughout, including honest documentation of
  trade-offs (unversioned Immich API, no ANN index, non-retroactive burst
  thresholds). Keep writing these.

## 3. Findings

### 3.1 Robustness — filesystem & data

| # | Finding | Status |
|---|---|---|
| R1 | `DiskStorage.put` wrote derivatives directly (no temp+rename): a crash left a truncated file under its final key, marked `ready`, and the integrity sweep only checks existence, not validity. | **Fixed** — `.part` → `rename` (`lib/storage/disk.ts`) |
| R2 | ML face replacement was N+2 autocommit statements: a crash mid-loop left a partial face set with `ml_status='processing'` and a `face_count` disagreeing with the rows. | **Fixed** — one transaction + one `jsonb_to_recordset` batch insert (`lib/ml.ts`, `tx()` in `lib/db.ts`) |
| R3 | Purge never reaped `asset_faces` / `asset_clip`: embeddings of purged assets (whose derivative can never be regenerated) accumulated forever and taxed the CLIP flat scan. | **Fixed** — purge deletes both (`lib/purge.ts`) |
| R4 | **No disk-space check anywhere** (zero `statfs` calls): a 200 GB export onto a full volume produces N per-file `ENOSPC` errors instead of one pre-flight refusal. | Roadmap P1 |
| R5 | Video proxies are fully buffered: `makeVideoProxy` does `readFile()` of the whole transcoded mp4 into the heap (`lib/video.ts`) under a 1 GB old-space limit. The HEIF path was fixed for exactly this; the video path wasn't. | Roadmap P1 |
| R6 | Flat derivative directories: `thumb/<id>.webp`, `proxy/<id>.*` — ~200k files in 2 directories at 100k assets. Painful for readdir/rsync/backup. | Roadmap P1 (shard by `id % 256`; needs a key-migration pass) |
| R7 | Remaining non-atomic multi-statement writes: `pairing.ts` group creation (3 statements), `bursts.ts restackSession` (2), session hard-delete (FS + DB interleaved, no compensating log). | Roadmap P1 — reuse `tx()` |
| R8 | Multi-hour ffmpeg jobs run against BullMQ's default 30 s lock (renewal-timer dependent), and compose sets no `stop_grace_period` (Docker's 10 s default SIGKILLs a long transcode on deploy). | Roadmap P1 |

### 3.2 Database

| # | Finding | Status |
|---|---|---|
| D1 | `/api/sessions` aggregated the **entire live library** on every page load (unscoped `GROUP BY session_id` subqueries over `assets`+`ratings` and `asset_groups`) — the #1 scaling cliff toward 500k assets. | **Fixed** — per-session `LEFT JOIN LATERAL`, carried by the new composite index |
| D2 | Seven unindexed FK children (`exports.export_job_id`, `purge_log.asset_id`, `duplicate_hits.existing_asset_id`, `bursts.cover_asset_id`, `ratings.rated_by`, `export_jobs.created_by`, `user_invites.created_by`) made every parent delete a child seq scan — session deletion was quadratic-feeling. | **Fixed** — migration `0034_perf_indexes.sql` |
| D3 | No composite index for the session grid keyset (`session_id` + `captured_at, id` + live guard). | **Fixed** — `assets_session_captured_idx` (0034) |
| D4 | Pool size was hardcoded (`max: 10` per process) and unreconciled with the sum of worker concurrencies; no `application_name` for pg_stat attribution. | **Fixed** — `DB_POOL_MAX` env + `application_name` (`lib/db.ts`) |
| D5 | `asset_faces.embedding` is ~6-8 KB of JSONB per face, **write-only** (nothing reads it): ~5 GB at scale with zero query path. Decide: ship person clustering (→ pgvector + HNSW) or stop storing it. | Roadmap P1 (decision) |
| D6 | `asset_clip` has no ANN index (deliberate: dimension-agnostic column). Exact flat cosine scan is fine ≤ ~100k rows; pin the model dimension and add HNSW before 1M. No telemetry marks the transition. | Roadmap P2 |
| D7 | Unbounded growth, no retention: `purge_log` (a row per retry of a refused purge), resolved `scan_failures`, `export_jobs.result` / `import_batches.result` JSONB, `exports` lineage, stale-model `asset_clip` rows after a model swap. | Roadmap P1 (janitor job) |
| D8 | Migrations are tracked by filename only — no checksum (silent no-op if edited after apply), no advisory lock, plus a hardcoded `RENUMBERED` shim. | Roadmap P2 |
| D9 | Postgres runs stock (128 MB `shared_buffers`) with no tuning and no memory/CPU limits in compose; the worker is the only bounded service. | Roadmap P1 |
| D10 | The `int8 → Number` type parser silently loses precision past 2^53 (unreachable today, unguarded). | Note |

### 3.3 Pipeline control & observability

| # | Finding | Status |
|---|---|---|
| C1 | Pause covered 2 of 9 queues: "Pause" left ML, geocode, integrity and gpswrite draining. Resume also omitted `finals` roots (inconsistent with bootstrap/periodic rescan). | **Fixed** — pause now covers all six background queues; ML/geocode throttles idle while paused; resume includes `finals` |
| C2 | `job.updateProgress()` was never called: a multi-hour scan showed as one opaque "active" job; the rich `IndexResult` went to stdout only. | **Fixed** — indexer reports live counters every 200 files → BullMQ progress → `/api/pipeline/queue` → scanning page |
| C3 | Backfills enqueued one job per Redis round-trip inside HTTP handlers (80k sequential `enqueueMl` calls). | **Fixed** — `enqueueMlBulk` (`addBulk`, chunks of 1000) |
| C4 | No cancel for an active job (only pause + priority preemption for scans). | Roadmap P1 |
| C5 | Two rate-limiting philosophies coexist: derivatives use BullMQ `rateLimit()` (job re-queued, no attempt burned — correct); scan/ml/geocode hold the worker slot in a sleep loop. Converge on `rateLimit()`. | Roadmap P1 |
| C6 | `srt-backfill` runs an unbounded library-wide loop inline in an HTTP handler (no timeout/progress/abort). | Roadmap P1 (move to a queue job) |
| C7 | Observability is `console.log`: no structured logs, no metrics, no `QueueEvents`; the worker healthcheck proves connectivity (SELECT 1 + Redis ping), not liveness; import/export/purge/geocode/integrity queues have no UI surface. | Roadmap P2 |
| C8 | `getSettings()` falls back to defaults on any DB error — a Postgres blip silently un-pauses the pipeline and lifts every rate limit. Fail closed (keep last-known values) instead. | Roadmap P1 |
| C9 | Job dedup is hand-rolled O(n) scans over Redis (`findPendingIndexJob` fetches up to 1000 jobs per enqueue) with an acknowledged TOCTOU window. Deterministic `jobId` (`scan:<rootId>`) would be O(1) and race-free. | Roadmap P2 |

### 3.4 External couplings

- **immich-machine-learning `/predict` is an internal, unversioned API** (the
  code says so, `lib/ml.ts` header). One mitigation exists (pin the container
  tag); add a startup version/contract probe with a readable failure message,
  and a smoke test to run after container upgrades. — Roadmap P1
- **Nominatim public instance is the default with geocoding enabled by
  default**; an upstream HTTP 429 is retried with exponential backoff (the
  wrong response to rate-limiting). Layered defenses (1 req/s budget, cell
  cache) make this mostly theoretical, but handle 429 as "wait, don't retry-
  burn" and consider defaulting `GEOCODE_ENABLED=false` on fresh installs. — P2
- The Immich **export** target correctly uses the versioned public REST API —
  the asymmetry with `/predict` is documented and intentional.

### 3.5 Code health

- **Zero automated tests** and no `make test`, while several pure functions are
  explicitly shaped for testing (`categorizeAsset`, `includeFromParams`,
  `snapToCell`, `lineageRole`, `requiredRole`, burst clustering, filter
  building). Start there — no mocks needed. — Roadmap P2
- Giant UI files: `settings/pipeline/failures/page.tsx` (~2000 LOC),
  `PipelineAssetList.tsx` (~1000), `GalleryShell.tsx`, `MediaViewer.tsx`.
  The backend is fine (largest lib ~570 LOC). — P2
- Small duplications: two near-identical `walk()` generators (indexer/import),
  three `exists()` helpers, the priority-selection ternary repeated 5×, the
  throttle loop 3× (now 2 pause-aware copies — extract a shared helper when
  touching next). — P2
- `docker-compose-optiplex.yml` env drift: its `x-winnow-env` anchor is missing
  `ML_CLIP_*`, `IMMICH_*`, `BURST_*`, `SHARP_CONCURRENCY`, `PURGE_*`,
  `HEIC_DECODE_TIMEOUT_MS`, `BROWSE_ROOTS`, `FINALS_DIRS` (and has no
  `/nas-final` mount). Defaults keep it working, but production silently cannot
  tune those. Generate both files' env blocks from one source, or switch to
  `env_file`. — P1
- The worker runs TypeScript via `tsx` in production, and the healthcheck
  boots a fresh `npx tsx` every 30 s. Precompile eventually. — P2

## 4. Prioritized roadmap

**P0 — shipped with this review** (see "Fixed" rows above): atomic derivative
writes; transactional batched face replacement (`tx()` helper); purge reaps
ML rows; migration 0034 (7 FK indexes + session-grid composite); `/api/sessions`
LATERAL rewrite; `DB_POOL_MAX` + `application_name`; global background pause +
pause-aware ML/geocode throttles + `finals` resume fix; scan progress reporting
end-to-end; bulk ML enqueue.

**P1 — next, highest value:**
1. Disk-space preflight (`fs.statfs`) before export/import/derivative batches,
   surfaced as one readable error (R4).
2. Stream video proxies to storage instead of buffering whole files (R5);
   align job lock/`stop_grace_period` with the 1 h ffmpeg timeout (R8).
3. Retention janitor (a small periodic queue job): prune resolved
   `scan_failures`, aged `purge_log`, stale-model `asset_clip`, old job
   `result` payloads (D7).
4. Decide `asset_faces.embedding`: build person clustering on pgvector, or
   stop storing embeddings (D5).
5. Cancel for running jobs (cooperative flag, like `shouldStop`) (C4); move
   `srt-backfill` out of the HTTP handler (C6).
6. Fail-closed `getSettings()` (C8); converge rate limiting on
   `Worker.rateLimit()` (C5).
7. Derivative directory sharding (R6); remaining transactions (R7); compose
   env-drift fix + Postgres tuning/limits (D9); immich-ml contract probe.

**P2 — sustainability:** first unit tests on the pure functions; migration
checksums + advisory lock; deterministic `jobId` dedup (C9); HNSW once the
CLIP model is pinned (D6); structured logging/metrics + UI surfaces for the
silent queues (C7); split the giant UI files; dedupe walk/exists/throttle
helpers; precompiled worker; Nominatim 429 handling.

## 5. Operating guidance (current knobs)

- **Pause** (`/settings/pipeline` → Pause): now suspends indexing,
  derivatives, ML, geocoding, integrity and GPS write-back. Import, export and
  purge are deliberately exempt — they are explicit user actions; pausing them
  mid-batch would strand half-moved files.
- **Rates** (`app_settings`, live): `scanPerHour`, `analyzePerHour`,
  `mlPerHour` (default 1200/h ≈ 67 h for an 80k backfill), `geocodePerHour`
  (default 3600 ≈ Nominatim's 1 req/s), `rescanMinutes`.
- **Concurrency** (env, restart): `SCAN/DERIVATIVE/EXPORT/IMPORT/PURGE/
  GEOCODE/ML_CONCURRENCY`, `SHARP_CONCURRENCY`. Keep the sum of concurrencies
  ≤ `DB_POOL_MAX` (each active job may hold a connection).
- **Thermals/noise**: the ML container is the CPU hog — lower `mlPerHour`
  (spacing is enforced between calls) or pause overnight; `SCAN_CONCURRENCY=1`
  and sequential exports are what keeps the HDD quiet, don't raise them for a
  spinning NAS.
