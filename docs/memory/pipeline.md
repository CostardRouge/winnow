# Pipeline (worker, queues, scanning, derivatives, ML)

Read before touching the worker, any BullMQ queue, scanning, derivative generation, ML, geocoding, rate limiting, or anything that affects worker memory.

Seeded 2026-08-20 from `docs/ARCHITECTURE-REVIEW.md`, `Dockerfile`, `src/lib/{indexer,derivatives,ml,rate,extract}.ts` and `.env.dist`. The review's §1 table (nine queues and their concurrency knobs) and §5 (operating knobs) are the reference; do not restate them here.

## Worker memory hygiene is load-bearing — do not casually undo it (2026-08-20)

**Decision**: the worker container runs with jemalloc `LD_PRELOAD`ed by bare soname, `MALLOC_ARENA_MAX=2`, `--max-old-space-size=1024`, `mem_limit` and `memswap_limit` set **equal**, `sharp.cache(false)` and `SHARP_CONCURRENCY=1`; HEIF decoding runs **out-of-process and serialized** (`src/lib/extract.ts`).

**Why**: each piece answers a measured leak. sharp/libvips churns large short-lived buffers that fragment glibc's allocator, which then never returns pages to the OS — RSS climbs and stays high; jemalloc keeps it flat. libheif's WASM heap grows monotonically within a process, so the only way to reclaim it is to end the process per file. `mem_limit` without an equal `memswap_limit` silently grants the container the same amount again as swap (that was a real regression — `fix(compose): stop the worker's mem_limit from silently granting it 4 GB of swap`, #195).

**How to apply**: treat these as a set. If you raise a concurrency knob, check what it does to peak RSS under a 1 GB old-space cap. `docs/ARCHITECTURE-REVIEW.md` R5 records the one path that still buffers a whole file in the heap (video proxies `readFile()` the transcoded mp4) — the HEIF path was fixed for exactly this reason and the video path was not.

## Stages chain manually; there are no BullMQ flows (2026-08-20)

**Decision**: each stage enqueues the next from inside its own job body (index → derivatives → ml/geocode; end-of-scan → pairing → bursts → edits → missing-file reconciliation).

**Why**: it is the shape the pipeline grew into, and it keeps each stage independently re-runnable and re-enqueueable.

**How to apply**: a new stage is enqueued by its predecessor, not declared in a flow graph. Expect no automatic parent/child failure semantics — if the chain must not break, the stage has to handle it. Several jobs deliberately swallow their own errors so a nicety cannot fail the whole scan (sidecar extraction, scan logging: "never let a scan fail because of the logging itself").

## Scanning is stat-gated and must stay that way (2026-08-20)

**Decision**: the indexer skips a file whose size+mtime are unchanged, before hashing and before exiftool.

**Why**: a re-scan of an unchanged 80k library then hashes nothing and spawns no exiftool — that is what makes a periodic rescan (60 s tick) affordable on a spinning HDD.

**How to apply**: anything you add per-file goes *after* the stat gate, or a rescan stops being free. The corollary is a real trap and is commented in the code: a fix that needs to reprocess already-indexed files cannot rely on a rescan, because the incremental scan will never revisit them — it needs an explicit re-enqueue or backfill (`src/scripts/*-backfill.ts` exist for exactly this).

## ML is a remote HTTP call to an unversioned Immich endpoint (2026-08-20)

**Decision**: faces, OCR and CLIP come from one multipart `POST /predict` to an `immich-machine-learning` container. Winnow embeds no models. The two local metrics (Laplacian sharpness, 64-bit dHash) are computed with sharp on bytes already in memory.

**Why**: running models in-process would blow the worker's memory budget and pin a model version into this repo. The endpoint being internal and unversioned is a knowingly accepted risk, mitigated by pinning the container tag.

**How to apply**: pin the ML container tag; after upgrading it, smoke-test the `/predict` contract before trusting a backfill. Contrast with the export path, which uses Immich's *public* API deliberately (`docs/memory/architecture.md`).

**Open**: `asset_faces.embedding` is ~6–8 KB of JSONB per face and is currently **write-only** — nothing reads it (review D5). Do not build on it assuming it is a queryable index; the decision to ship person clustering on pgvector or stop storing embeddings is still the maintainer's.

## Pacing: two philosophies coexist, one is correct (2026-08-20)

**Decision**: rates are a shared Redis token bucket (`src/lib/rate.ts`) with live-tunable per-hour budgets in `app_settings` (`scanPerHour`, `analyzePerHour`, `mlPerHour`, `geocodePerHour`); concurrency is env/boot-time. Pause is two-layer — BullMQ queue pause plus a DB flag checked mid-job.

**Why**: rates need to change without a restart (thermals, noise, an overnight backfill); concurrency does not.

**How to apply**: derivatives use BullMQ's `rateLimit()` — the job is re-queued and no attempt is burned. Scan/ML/geocode instead hold the worker slot in a sleep loop. `rateLimit()` is the target shape (review C5); prefer it for anything new. Import, export and purge are deliberately **exempt from pause**: they are explicit user actions and pausing them mid-batch would strand half-moved files.

## Reverse geocoding leans on a cell cache, not on the provider (2026-08-20)

**Decision**: Nominatim (public instance by default) behind a coordinate-cell cache in `places`, which collapses ~90k geotagged assets into a few hundred calls, at a ~1 req/s budget.

**Why**: the public instance's fair-use policy is the binding constraint, and the cache — not the rate limit — is what actually makes the workload legitimate. A "no place here" answer is cached too (all-null names), so an empty cell is never re-queried.

**How to apply**: never bypass the cell cache for a bulk operation. Note the known bug: an upstream HTTP 429 is currently retried with exponential backoff, which is the wrong response to rate limiting (review §3.4).

## Thermals and disk noise are a real design constraint (2026-08-20)

**Decision**: `SCAN_CONCURRENCY=1` and sequential exports are what keep the HDD quiet; the ML container is the CPU hog and is paced by `mlPerHour` (default 1200/h ≈ 67 h for an 80k backfill) rather than by concurrency.

**Why**: this runs on an Optiplex in a home, not in a rack. "Faster" is not automatically better here.

**How to apply**: do not raise scan concurrency or parallelise exports for a spinning NAS. If a task feels too slow, propose a rate change (live, no restart) before a concurrency change (restart, memory implications).
