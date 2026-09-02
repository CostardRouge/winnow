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

## A moved original deadlocks the pipeline — there is no move detection (2026-09-02)

**Fact**: asset identity is `abs_path` (UNIQUE). A file moved to another folder
inside the same root is therefore modelled as two unrelated events, and the two
of them lock each other:

1. at the new path the file is "new"; its INSERT hits `ON CONFLICT
   (content_hash) DO NOTHING` because the old row still holds the hash;
2. the collision-recovery branch calls `sameContent(new, old)`, which reads the
   **old** path — now ENOENT — so it answers `null` ("unverifiable"), not
   `false`. Only `false` triggers the recovery insert, so the file is counted in
   `duplicates` and **never indexed**;
3. end-of-scan `reconcileMissingForRoot` does not see the old path, confirms
   ENOENT, and sets `missing_at` + auto-trash.

**Why it matters**: this is a *stable* state — every rescan repeats it verbatim
(only `duplicate_hits.hits` increments). It never self-heals, and scanning more
often only reaches it faster. Diagnosing a mass "missing" event therefore starts
with "was anything moved?", not with scan cadence.

**How to recover**: `npm run relink-moved` (dry run) → `-- --apply`
(`lib/relink.ts` + `scripts/relink-moved.ts`). It walks the root, hashes only
the unindexed files whose size matches an orphan, and moves each row onto its
file. Relink, never reindex: derivative objects are keyed by asset id
(`thumb/${id}.webp`), so id, rating, tags, pairing, burst membership and the
edit link all survive, and `mv` keeps the mtime so the next scan skips the file
at the stat gate. It moves `abs_path` **and** `rel_path` **and** `session_id`
(one session = one directory) and lifts the auto-trash only when `deleted_at =
missing_at` — the marker that says the trash is ours, same contract as
`restoreMissing`.

**Purging the missing rows recovers nothing and makes it worse — but it is not
fatal.** The purge worker stamps `purged_at` without releasing `content_hash`
(only `reclaimTrashedAsset` in `lib/duplicates.ts` does, and its comment
explains why it must), so a purged row keeps squatting the unique hash and the
moved file stays unindexable *forever*. What a purge actually destroys is
narrow and rebuildable: the thumb/proxy objects, the `asset_faces` /
`asset_clip` rows, and the `asset_sidecars` rows (whose files it failed to
unlink — they moved with the clip — while deleting their rows anyway). Ratings
are kept by design and every column on the asset row survives, so `relink-moved`
handles purged rows too: it un-stamps the purge and re-enqueues one derivative,
which re-enqueues ML on completion. Note purged rows vanish from the Missing
triage list (`listMissing` filters `purged_at IS NULL`), which makes the purge
*look* like it worked.

**"Keep only this copy" is not the escape hatch either**: it refuses to relink a
*trashed* library copy and reclaims it instead (row purged, rating/tags/faces
lost, reindexed fresh) — precisely the state auto-trashed missing assets are in.
It cannot currently tell "the user culled this" from "we trashed it because we
could not find it", although `deleted_at = missing_at` says so.

**Known reporting drift, deliberately not patched**: a purge of an already-absent
original adds its `file_size` to the job's `freedBytes` and writes a `'purged'`
`purge_log` row although it unlinked nothing, and `relink-moved` leaves that row
in place (the purge did run; `purge_log.status` is `CHECK (purged|error)`, so
recording a correction would need a migration).

Restoring from the triage page does not help either: it clears `deleted_at` and
leaves `missing_at` set, so the asset returns to the library still pointing at a
dead path — and `markMissing`'s `AND missing_at IS NULL` guard means it is never
re-trashed. It just sits there, live and broken.

**The fix is not speed, it is modelling.** The state of the art for move
detection is `(st.dev, st.ino)`, not the hash: the inode is the only identifier
the filesystem keeps stable across an intra-volume `mv`, and the `stat` is
already done in the hot loop, so it costs nothing. Store it, and an unknown
`abs_path` whose inode matches a row with an ENOENT path is a move → update the
path in place. It does not survive a copy or a cross-volume move, hence the
cheap fallback that would already fix the case above: in the collision branch,
tell "unreadable" (EACCES/EIO) from "gone" (ENOENT) — a colliding row pointing
at an ENOENT path is not a duplicate, it is the same file elsewhere. Do **not**
reach for a chokidar watcher on the source roots: it costs a lot of inotify
watches on an 80k tree and only ever catches *future* moves, while the inode
catches the ones made while the worker was down too.

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

## Burst piles split into action vs bracket, two-tier detection (2026-08-23)

**Decision**: a pile (migration 0029) is classified `bursts.kind` = `action`
(continuous shooting) or `bracket` (exposure-bracketed / AEB), once, at
pile-creation time in `reconcileBurstsForSession` (`src/lib/bursts.ts`).
Tier 1: any member frame carries a real (`> 0`) `bracket_shot_number` — the
maker's explicit MakerNotes bracket-sequence index (exiftool's composite
`BracketShotNumber`, absorbing the per-brand variants the same way
`ShutterCount` does). Tier 2 fallback: the frames' `exposure_compensation` (EV,
exiftool's `ExposureCompensation`) spreads by more than
`BURST_BRACKET_EV_EPSILON` (default 0.05). Both columns land on `assets` via
migration `0039_burst_kind.sql`.

**Why two tiers**: the explicit tag is only ~4% frequency and Sony/Canon/
Panasonic-specific; the EV-spread fallback is what makes iPhone and DJI drone
bracket sequences detectable too, since neither stamps the maker tag. Grouping
itself (temporal gap + device, unchanged) can't tell the two apart — a
continuous burst and a bracket sequence cluster identically.

**Trap already fixed once, don't reintroduce it**: `BracketShotNumber` reads
`0` on an ordinary (non-bracketed) frame from a body that stamps the tag at
all — 0 is the maker's "not bracketing" sentinel, not "shot #0". A classifier
that tests `!= null` instead of `> 0` would flag every such frame's pile as a
bracket. `int()` in `lib/extract.ts` still stores `0` (a real, meaningful
value) — the `> 0` guard belongs in the consumer, not the extractor.

**How to apply**: classification runs once and is never re-evaluated by an
ordinary rescan (`reconcileBurstsForSession` only touches `burst_id IS NULL`
frames, same as clustering itself) — an existing pile only gets reclassified
via the `restackSession` escape hatch, after its frames' EXIF has actually been
re-read. `BURST_BRACKET_EV_EPSILON` isn't yet in `docker-compose-optiplex.yml`'s
`x-winnow-env` anchor — same pre-existing gap as `BURST_GAP_SECONDS`/
`BURST_MIN_FRAMES`, tracked in `MEMORY.md`'s open items.

## Thermals and disk noise are a real design constraint (2026-08-20)

**Decision**: `SCAN_CONCURRENCY=1` and sequential exports are what keep the HDD quiet; the ML container is the CPU hog and is paced by `mlPerHour` (default 1200/h ≈ 67 h for an 80k backfill) rather than by concurrency.

**Why**: this runs on an Optiplex in a home, not in a rack. "Faster" is not automatically better here.

**How to apply**: do not raise scan concurrency or parallelise exports for a spinning NAS. If a task feels too slow, propose a rate change (live, no restart) before a concurrency change (restart, memory implications).
