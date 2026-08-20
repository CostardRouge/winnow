# Architecture

Read before touching the overall shape: the storage layer, deduplication, the originals policy, the app/worker split.

Seeded 2026-08-20 from `README.md`, `docs/ARCHITECTURE-REVIEW.md`, `src/lib/` and the compose files. `README.md` "Architecture" and the review's §1 system map are the reference; this file keeps only what a change is likely to violate.

## The originals are read once — everything else is derived (2026-08-20)

**Decision**: the NAS RAWs/videos are read exactly once, at index + derivative generation. Browsing, culling, search and queries go through Postgres and the derivative cache; deletes are soft (`purged_at` marks bytes gone while the asset row survives, so a purged file is never re-indexed as new).

**Why**: the library lives on a spinning HDD on a home NAS. Re-reading originals is slow, noisy and thermally expensive, and every extra read is a chance to damage what cannot be regenerated. The NAS session mounts are therefore `:ro` in every compose file; only the `incoming` zone (imports) is mounted read/write.

**How to apply**: a feature that wants to re-read an original needs an explicit reason and a mount that allows it. If you need more from a file, get it during indexing/derivative generation, not in a later pass. Culling operates on proxies, never on RAWs.

## Derivatives: disk cache behind an S3-shaped interface (2026-08-20)

**Decision**: derivative storage is a small driver interface (`src/lib/storage/`) with a disk implementation as the default; `STORAGE_DRIVER=s3` switches it to MinIO without touching call sites (§12 decision 1 in `README.md`).

**Why**: the MVP does not need object storage, but the maintainer did not want the disk assumption to leak into the pipeline and make MinIO a rewrite later.

**How to apply**: never read or write a derivative path directly — go through the storage driver. `DiskStorage.put` writes `.part` then renames (review finding R1): keep that atomicity in any new driver or write path, because the integrity sweep only checks that a key exists, not that its bytes are valid.

**Known cost, not yet paid**: derivative keys are flat (`thumb/<id>.webp`, `proxy/<id>.*`), so ~200k files land in two directories at 100k assets. Sharding by `id % 256` is on the P1 roadmap and needs a key-migration pass (R6).

## Deduplication: partial hash, arbitrated by full compare, always logged (2026-08-20)

**Decision**: an asset's `content_hash` is partial (size + two 64 KiB windows) behind a unique index. A suspected duplicate is confirmed by a **full-content compare** before being dropped, and every decision is recorded in `duplicate_hits`.

**Why**: a partial hash is what makes an 80k-file scan cheap, but a false collision would silently lose a photo. The full compare makes a collision cost time, not data; the audit table means a dedup decision can always be explained afterwards.

**How to apply**: keep the invariant "a suspected duplicate is never dropped without a full compare, and never dropped silently". A trashed duplicate is deliberately *not* treated as present (`src/lib/duplicates.ts`), so restoring one behaves sensibly.

## One implementation per operation; `src/lib/` owns the logic (2026-08-20)

**Decision**: business logic lives in `src/lib/*.ts`. The worker (`src/worker.ts`), the API routes under `src/app/api/**` and the CLI scripts in `src/scripts/` are thin wrappers calling the same functions.

**Why**: the same operation is reachable three ways (UI, queue job, `npm run scan`-style script). Duplicating it means three behaviours that drift.

**How to apply**: add the logic to `src/lib/`, then wire the route/job/script to it. If you find yourself writing a query inside a route handler, it probably belongs in `lib`. The backend holds this well (largest lib file ~570 LOC); the UI does not (see `docs/memory/frontend.md`).

## Immich is a peer, not a dependency to absorb (2026-08-20)

**Decision**: Immich stays the browsing/phone library. Winnow *pushes copies* of a culled session's keepers through Immich's public, versioned REST API (`IMMICH_ENABLED`, off by default) and never writes into Immich's storage or database.

**Why**: the two tools have different jobs, and the maintainer explicitly refuses to couple Winnow to Immich's internals for the export path.

**How to apply**: keep export traffic on the public REST API. Note the deliberate asymmetry — the ML path *does* call Immich's internal, unversioned `/predict` (see `docs/memory/pipeline.md`), and `docs/ARCHITECTURE-REVIEW.md` §3.4 documents why that is accepted where the export path's coupling would not be.

## Guards on destructive paths are layered on purpose (2026-08-20)

**Decision**: purge carries three guards plus a mass-disappearance guard on missing-file reconciliation — if a large share of the library vanishes at once, it flags instead of auto-trashing. Exports and imports copy via `.part` → verify → `rename`.

**Why**: an unmounted NAS looks exactly like "every file was deleted". The guard is what stops one bad mount from soft-deleting the library.

**How to apply**: any new sweep that deletes or trashes in bulk needs the same "does this look like an unmounted volume?" question answered before it acts.
