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

**How to apply**: anything you add per-file goes *after* the stat gate, or a rescan stops being free. The corollary is a real trap and is commented in the code: a fix that needs to reprocess already-indexed files cannot rely on a rescan, because the incremental scan will never revisit them — it needs an explicit re-enqueue or backfill (`src/scripts/*-backfill.ts` exist for exactly this) — and that backfill has to be reachable from the UI, not only from a shell (see MEMORY.md, working preferences).

## A scan failure is a file's fault, or the scan stops (2026-10-11)

**Decision**: the indexer's per-file `catch` records a `scan_failures` row only for a file's own fault; a Postgres error of class `42` (`isSchemaError` in `lib/failures.ts`: undefined column/table, syntax, privilege) rethrows and fails the whole index job, before the missing-file reconciliation. And a scan resolves the open failures it walks through cleanly: they are read ONCE per scan by path prefix (`openScanFailures`), and the per-file `finally` resolves a hit — `resolveScanFailure` had existed since 0006 and nothing called it, so only a Retry ever closed a row.

**Why**: 0048/0049 shipped unapplied and the indexer logged 9 124 "failures" that were one missing column; each failed file has no row, so every rescan re-hashed and re-exiftooled its original again (65 attempts in a day) — the "originals read once" rule broken by a logging path. **How to apply**: a new per-file error that means "the code is wrong" (not "the file is") belongs in `isSchemaError`'s family, not in the table. Failures › Scan should now empty itself on the next rescan after a cause is fixed; a row that stays open is a file still failing.

**A file that is gone closes its failure too (2026-10-14).** Resolving on the walk could never reach a deleted path: one dedup run (folder `…/Selects`, deleted while a scan was walking it) left 113 `ENOENT` rows open for good, and the dedup's unlink does not touch `scan_failures`. The end of a COMPLETE walk now closes the open failures under the root it did not meet, each on its OWN `ENOENT` (`resolveVanishedScanFailures`, `IndexResult.vanishedFailures`), and only when the walk met at least one media file — an unmounted share is an empty mount point where every path is ENOENT. Any other stat error leaves the row open. The attempts counter is cumulative and `error` keeps only the LAST message, so a row reading "47× ENOENT" had mostly failed on something else (here, the 0048/0049 column).

## Derivative sources: the preview first, the sensor only when there is none (2026-10-11)

**Decision**: `extractSourceJpeg` keeps the embedded preview as THE path, and
adds two fallbacks measured on the instance's 13 derivative errors: (1) the
first 12 bytes decide before the extension does — a JPEG/PNG/WebP goes straight
to sharp (TIFF magic deliberately excluded: every RAW is a TIFF container);
(2) a RAW with no embedded image at all is demosaiced by LibRaw's `dcraw_emu`
(`libraw-bin` in the Dockerfile), half size, out-of-process, serialized, 120 s
cap, with the DNG's `BaselineExposure + BaselineExposureOffset` applied as
`-aexpo` (LibRaw ignores it; without it an iPhone DNG renders ~1¼ EV darker
than macOS shows it). LibRaw applies the orientation itself, so that path
returns none — re-applying it rotated twice in the first test.

**What the failures were** (all `/nas-incoming/iphone/photos/2025/august 2025`
or summer 2026): five iPhone 15 Pro Max DNGs whose XMP says `cr_sdk (iOS)` and
`Indigo Embedded Camera Profile` (Adobe's camera SDK, not Photomator) with only
the raw CFA + a sky semantic mask — no preview of any size; two `IMG_E….HEIC`
that are baseline JPEGs (an edit's rendition exported under the original's
extension); six `.MOV` with no readable `moov` — five cut at exact MiB sizes
(`mdat` declares 786 MB, the file holds 654 MB: an interrupted copy), one whose
first bytes are garbage. The videos are not Winnow's to fix: the error now
says "Damaged file … copy it again from the source" ahead of ffmpeg's tail
(`ffmpegHint`, and `-hide_banner` so the 400-char tail is the cause, not the
build banner).

**Traps**: LibRaw refuses a frame under 22 px a side (the synthetic DNG in
`extract.test.ts` is 64×32 for that reason); sharp's prebuilt libvips reads
TIFF but NOT PPM, so `-T` is required. The "very dark" DNGs the maintainer
reported are, for the 10 darkest of 2 877 measured thumbnails (mean luma < 12),
genuine night/astro frames, not a rendering bug. **How to apply**: a new
"cannot build a derivative" family starts by pulling the original read-only
through `/api/assets/:id/download` (it ignores `Range` and sends the whole
file — mind the disk) and asking exiftool/`file` what it really is.

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

**How to recover**: *Failures › Missing files › "Moved, not deleted"* — **Scan
for moved files**, then **Relink**. `npm run relink-moved` (dry run) →
`-- --apply` is the same pass from a shell (`lib/relink.ts` +
`scripts/relink-moved.ts`). It walks the root, hashes only
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

**A moved clip's sidecars follow it, and the old rows go (2026-10-13).** Relink
re-records a video's sidecars from its new folder, but `asset_sidecars` is keyed
on `abs_path`, so the rows of the folder it left stayed: on the maintainer's
instance, 263 `.SRT` rows for 156 drone clips, the 107 extra all dead and listed
FIRST by the asset query (`ORDER BY sc.id`), so Atelier asked them and got 404s.
`recordSidecars` now treats the folder's listing as the whole truth and drops
the asset's rows it does not hold (rows only, never a file; nothing pruned when
the folder cannot be listed), which covers relink and every re-index; migration
`0054_sidecars_left_behind` cleared what had accumulated (a row whose directory
is not its asset's). **How to apply**: anything that re-points an asset's
`abs_path` must call `recordSidecars` for the new folder, or its sidecars keep
pointing at the old one.

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

## The relink pass rides the integrity queue, told apart by job name (2026-09-02)

**Decision**: `enqueueRelink` adds to the **integrity** queue under the job name
`relink` (`RELINK_JOB`), and the integrity worker branches on `job.name`. No new
queue, no new table: the report is the BullMQ job's **return value**, read back
by `getRelinkJob` and polled by the UI.

**Why**: a relink has the integrity sweep's exact I/O profile — a full walk plus
a stat per file — and that queue's `concurrency: 1` is what stops the two from
ganging up on the spinning HDD. A `relink_jobs` table would have duplicated
`purge_jobs` for a repair tool; completed jobs are retained (`removeOnComplete:
{ count: 1000 }`), which is history enough.

**The trap this created, already fixed — do not reintroduce it**:
`enqueueIntegrity` coalesces against *pending jobs on its queue*, and originally
matched on `data.rootId` alone. With two job kinds sharing the queue that would
hand a sweep request an existing **relink** job and report it as the sweep.
Anything that inspects pending integrity jobs must filter on `job.name` first.

**How to apply**: a queued job whose result the UI needs can return it and be
polled through `getJob` — no table required. Note the consequence of the shared
queue: `pauseAllQueues` includes `integrity`, so a paused pipeline holds a
relink too (the UI says so rather than spinning silently). Relink jobs run with
`attempts: 1` — a blind retry would re-walk a tree the first attempt already
half-changed — so the per-row work is individually try/caught instead, the same
isolation the indexer gives each file.

## ML is a remote HTTP call to an unversioned Immich endpoint (2026-08-20)

**Decision**: faces, OCR and CLIP come from one multipart `POST /predict` to an `immich-machine-learning` container. Winnow embeds no models. The two local metrics (Laplacian sharpness, 64-bit dHash) are computed with sharp on bytes already in memory.

**Why**: running models in-process would blow the worker's memory budget and pin a model version into this repo. The endpoint being internal and unversioned is a knowingly accepted risk, mitigated by pinning the container tag.

**How to apply**: pin the ML container tag; after upgrading it, smoke-test the `/predict` contract before trusting a backfill. Contrast with the export path, which uses Immich's *public* API deliberately (`docs/memory/architecture.md`).

**Open**: `asset_faces.embedding` is ~6–8 KB of JSONB per face; review D5 called it write-only, but since People shipped `lib/people.ts` reads it (centroids, clustering — checked 2026-10-02). Do not build on it assuming it is a queryable index; the decision to ship person clustering on pgvector or stop storing embeddings is still the maintainer's.

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

## A DJI clip carries no camera at all, and device is a join key (2026-09-19)

**Fact**: `readMetadata` builds `assets.device` by joining `Make` + `Model`
(`src/lib/extract.ts`). A DJI **photo** yields `DJI FC8482` — the
flight-controller board code, prettified for display only by
`lib/cameraLabels.ts`. A DJI **video** yields nothing: the MP4 carries neither
atom. Sony XAVC-S and iPhone clips carry both, which is why the gap looks like a
drone problem rather than a video problem.

**Consequence**: `device` is the grouping key of every gear-shaped view, so those
clips are not missing from a filter — they are absent from the whole dimension.
`lib/gear.ts`'s aggregate requires `a.device IS NOT NULL AND a.device <> ''`,
`/api/facets` drops null/empty values, `?device=` is `a.device IN (…)`
(`lib/filter.ts`), and the viewer's Camera/Device rows are omitted when null
(`gallery/AssetMeta.tsx`). The drone's card on `/gear` therefore counts
`videos: 0` and links to a grid that can never hold them.

**What the file does hold** (measured 2026-10-10 on two real Mini 4 Pro clips
of the library, pulled read-only through the API): the first sample of the
`djmd` track is a protobuf header carrying `1-1-10` Model (`DJI Mini4 Pro`),
`1-1-5` the AIRCRAFT serial (`1581F…`) and — the field that settles the
two-spellings trap below — `2-2-1-4` = `DJI FC8482`, the camera exactly as its
stills write Make + Model. That one field is the join key; nothing else is
needed. Traps found on the way: the stills' EXIF `SerialNumber` is the CAMERA's
(`6TVQ…`), not the aircraft's, so serials never join a clip to its photos; the
plain `-fast` read already returns `Encoder: DJI Mini4 Pro` (product, not body);
and `exiftool -ee` reads EVERY sample of the track (one seek + read per frame,
~13 000 in a 3.7 GB / 223 s clip) for values that sit in the first one. DJI
writes `moov` LAST, after the `mdat`, beside a ~1 MB `udta`.

**The trap that survives whichever fix is chosen**: the embedded `Model` is the
aircraft's own name, not `FC8482`, so writing it raw into `device` buys a
*second* gear card for one aircraft. Anything that fills the column for videos
must land on the string the photos already use — which is why the probe writes
`2-2-1-4`, never `Model`. `cameraLabels.ts` cannot be a canonical key: it is
display-only by design, because the raw value is what the grids filter on (the
count/grid guarantee argued at the top of `lib/gear.ts`).

**How it is read** (2026-10-10, `lib/djiTrack.ts`, `lib/deviceProbe.ts`,
migration 0049): our own reader, not `-ee` — top-level box headers, `moov`'s
children header by header (the `udta` stepped over), the `djmd` trak, ONE
sample: ~2–4 ms and a few KB whatever the clip weighs, against 0.3–0.6 s for
`-ee` on a 3 s clip. Unknown DJI protos keep model + serial and write no body
(only the Mini 4 Pro has been seen). The answer is `device_source='embedded'`
with `embedded_device/_camera_model/_model/_serial/_probed_at` beside it; it is
the FILE speaking, so it beats `derived`/`manual` and yields to `override` and
to EXIF. Delivery: the indexer probes every new/changed video whose EXIF names
no body; Settings › Pipeline › Devices step 1 enqueues a `device-probe` job on
the **integrity** queue (not index: that queue is per-root scans behind a scan
lock) at the scan's budget and pause, resumable, its report the job's return
value. A file that cannot be opened is never stamped — an unmounted share must
not mark the library "read, nothing found". Revert goes to EXIF, else the
track's body, else none.

**How it is answered today** (2026-09-20, `lib/deviceAttribution.ts`, migration
0043): not by reading the file again but by **voting on what the index already
knows**, and letting a human apply the verdict from Settings › Pipeline ›
Devices. Five signals, weighted: a parsed DJI flight log (3), a tied `.SRT` at
all (2), a maker filename (2), the busiest body of the SAME folder (3), a folder
name that says drone (1); at 5 the row is pre-ticked. No signal is decisive
alone, which is the whole reason it is a vote — `.srt` is also the world's most
common subtitle extension, and a `DJI_` prefix dies on rename.

**It is browsed by FOLDER, and that is the design, not the presentation**
(2026-09-20). A flat list of media ranked by date is unusable past a few
hundred: the drone clips of May sit between a January screenshot and a June
Sony clip, and "keep attributing the drone" becomes hunting — the first cut
shipped that way and the maintainer hit it within one session. One folder is
one shoot is, very nearly always, one body, so a folder is a card with one
verb, a body facet turns "the drone ones" into a click, and the per-file list
inside a card is the exception path for a folder that held two cameras. The
card is the same `.session-card` as Unplaced's, on purpose.

**The score is written twice and must stay identical.** `scoreCandidate()`
weighs one row in JS; `scoreSql()` weighs a whole folder in SQL, because the
folder aggregate and the folder apply cannot afford a row trip. Both read
`SIGNAL_WEIGHTS`, and both regexes are passed to Postgres as `.source`
parameters — so the rule has one home, at the cost of one constraint: the
patterns must stay inside the POSIX ERE subset (no `\d`, no `\b`, no
lookaround). After touching either, check them against each other on real
rows; `deviceAttribution.test.ts` pins it (the folder aggregate's
`confident` and signals against the per-medium JS verdict, and the
confident-only folder write against the rows JS ticks). Both whole-library
reads (`listFolders`, `listKnownBodies`) run through `manyWithoutJit`.

**The backlog is Incoming's; the Gallery is shown, never counted**
(2026-10-11, maintainer's word). The Gallery holds finalized masters accepted
as they are — a 2009 webcam shot, a QQ avatar, a macOS screenshot has no camera
to find — so the nav badge (`/api/stats` `device_missing`, now
`countUnattributed({ source: "incoming" })`, which also stopped counting purged
rows the page never listed) and the page's default are Incoming only; the
Incoming/Gallery/All picker beside step 2 is NOT remembered between visits, so
looking at the Gallery is a deliberate click each time. An ignored session is
out of every half. Both rules live in ONE predicate, `backlogScopeSql`, used by
the listing and the counts, never by a write. Measured on the instance that
day: 113 left, 53 Incoming / 60 Gallery — and the "friend's Sony" folder was 14
`WhatsApp Image …` files: WhatsApp strips EXIF, so anything received through it
lands here whoever shot it.

**Winnow indexes no stream metadata** — no codec, no frame rate, no nominal
bitrate — because nothing calls `ffprobe`: the derivative worker hands the file
straight to `ffmpeg` (`lib/video.ts`). The Devices table therefore prints an
AVERAGE bitrate derived from size over duration (`formatBitrate`), labelled as
such, and says nothing about codecs. Adding them means a column, a pass and a
decision about re-reading originals — but note the cheap route before reaching
for a backfill: ffmpeg already walks every video to build its proxy, so the
figures could be captured from that run rather than from a second read.

**A folder apply is a predicate, never a list of ids**: `applyFolder` resolves
"this folder's unattributed media, optionally only the confident ones" inside
the UPDATE, so a 129-clip folder costs one statement and cannot drift between
what the card promised and what the write touched.

**The sibling signal is what dodges the two-spellings trap**: the proposal is
always the body of a neighbouring medium, so an attributed clip lands on the
card its own stills already built instead of minting a second one. Signals that
merely argue "this is a drone" never invent a string; with no sibling the row is
listed with its score and no proposal, and the picker (populated from the bodies
the library actually holds) is the answer. Keep it that way — the value written
must be one the gear dimension is already grouping on. The ONE sanctioned
exception is a typed name, recorded as `'named'` (next entry).

**Three writes, deliberately separate** (2026-10-09, migration 0048): *fill*
gives a body to media that have none and never touches one that does — the
default everywhere (folder cards, per-row menus, the grids' bulk *Set camera
body…* in `DevicePickerModal`); *override* REPLACES a body, the file's own
included, for a file that names the wrong camera (a borrowed body, an app's
generic model, a re-encode); *revert* puts media back to what their files
say — or to no body, where the file names none, which returns them to the
Devices backlog. One endpoint, `mode: fill | override | revert`; the two that
can change an existing body take explicit ids only (never a folder predicate)
and are never reached by leaving a field out. In the dialog, replacing is a
ticked box that names how many media it touches. The maintainer asked for
correction explicitly after the first cut refused it; do not quietly fold it
back into fill.

**Two hand answers when no body fits: a camera named, or none** (2026-10-11,
migration 0051, the maintainer's ask). `'named'` writes a typed name into
`device` itself ("Appareil d'Emeric", "the wedding photographer") so /gear, the
facets and `?device=` need no code; `'none'` leaves `device` NULL and only takes
the medium out of the backlog — screenshots, webcam frames, app images. No new
column (he weighed an "ignored" boolean and asked for the minimum); nothing is
hidden, both are filterable (`?device_source=`, the "Body source" facet, whose
`exif` also matches pre-0043 NULL-provenance rows). Rules that keep the free
text from drifting: a name already given is reused whatever its case/spacing;
a name equal to a body some FILE declares is refused (`DeviceNameTaken`, 400);
a fill / folder proposal / vote that writes a named body records `'named'`, not
`'manual'`/`'derived'`, so the filter keeps meaning "a camera I have no file
for". By ids they touch only rows whose body did not come off their file
(hole, derived, manual, named, none) — that is how a screenshot once assigned
to the iPhone by hand gets set aside — never exif/embedded/override. Both
revert, both survive a re-index, both yield to a file (EXIF or the clip's
track) that later names a body. Two card-level suggestions ride on the
folder aggregate, both one click and never applied alone: a folder of nothing
but PNGs proposes "not a camera" as its primary verb (no camera writes PNG;
`pngs`), and a folder of nothing but `WhatsApp Image/Video …` files (`received`)
keeps its sibling proposal on screen but not as the button nor in "Apply every
proposal shown" — WhatsApp strips EXIF, so the folder's body is the
maintainer's, not the sender's (the farewell-party case). A card with no
proposal opens its menu from the primary button ("Decide N"), never a dead
"No proposal". "My own cameras" is a separate dimension, not a provenance:
whose body it is lives in `gear_owners` (0053, `docs/memory/frontend.md`).

**The indexer guard is the load-bearing part**, three rules in order:
`device_source = 'override'` keeps the human's body whatever the file says;
otherwise a file that names a body wins (`'exif'`); otherwise an attribution
(`'derived' | 'manual' | 'embedded'`) survives a file that names nothing — the
`gps_source='manual'` contract since 0031. Beside it, `device_exif` /
`camera_model_exif` record what the file declares on EVERY index, whatever won:
that is what lets the viewer print "corrected — file says X" and what *revert*
restores, so an override is never a silent rewrite. It also means revert
restores the file's CURRENT value, not the one it had when the correction was
made. Verified through the real `indexRoot` over a real EXIF-tagged JPEG: an
override survives an mtime bump AND a genuine change of the file's Model, while
`device_exif` follows the file. Re-run that lifecycle if you touch the UPDATE.
Not written into originals: Make/Model are a camera's identity inside RAW maker
notes and MP4 atoms — unlike a GPS pin, nothing outside Winnow needs them fixed.

## One camera, two names: a Make left out of the clips (2026-10-14)

**Fact** (measured on the instance): the Ray-Ban Meta glasses write `Make =
Meta AI` + `Model = Ray-Ban Meta Smart Glasses 2` in a HEIC photo and only the
Model in a MOV clip, so `device` (Make + Model) gave two bodies: 254 photos on
one card, 301 clips on the other. Other cameras may do it; this one showed it.

**Decision** → `lib/deviceMakes.ts`: a body whose name IS its model (no Make,
not `'named'`) joins the ONE full spelling `<Make> <Model>` that the model's
files declare (`device_exif`, never a hand-given body). Two makers for one model
is reported, never merged; a model no file gives a Make for stays as it is —
nothing is guessed. It moves `device` on every row carrying the short name
(any provenance: a hand-pick of it meant that camera), rewrites `device_exif`
to the full spelling too (so revert lands on the joined body instead of
splitting it again — `device_exif` is "the file's body in the spelling its
model's files agree on"), and carries the `gear_owners` row (the full name's
own answer wins). **Where it runs**: the indexer at the END of every scan for
the models that scan read (the per-file UPDATE still writes the raw name; the
join right after makes it stable), which covers both orders — a new clip joins
the stills, a first still with a Make pulls in the clips before it; and
Settings › Pipeline › Devices "One camera, two names" (shown only while a pair
exists) for the backlog. Not the merge of differently-named bodies the
maintainer deferred (2026-10-13): it only joins names that differ by a missing
Make. Postgres trap met on the way: `full` is reserved (`FULL JOIN`) — it
cannot be a column alias in `unnest(...) AS p(model, full)`.

**Still open**: the serial is recorded (`embedded_serial`, the viewer's
"Unit" row) but nothing groups on it — two identical aircraft still share one
gear card. Grouping by unit is a gear-shelf decision, not a probe one.
