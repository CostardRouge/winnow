# ML-assisted culling

Winnow scores each photo to help you cull faster: which frames are **soft/blurry**
and which are **near-duplicates** of each other (bursts, re-frames, near-identical
retries). It is **advisory** — it filters and ranks, it never rates or deletes on
its own. Nothing is ever lost by the analysis; it only surfaces candidates for the
human cull.

This document covers what ships today (Phase 0 + 1) and the roadmap.

## Guiding constraints

These shaped every design decision:

- **Touch the RAW only once.** The analysis runs on the lightweight **proxy**
  (the 2048px WebP already in the derivative cache), never on the RAW. A RAW is
  read exactly once, at indexing, to build its derivatives.
- **CPU-only, no model download (Phase 1).** The Optiplex has no discrete GPU
  (its iGPU only does video encoding via VAAPI). Phase 1 is pure classic computer
  vision — variance of the Laplacian, a DCT perceptual hash — so it runs on the
  same `node:slim` worker image with no native ML runtime and no bundled model.
- **Decoupled & rate-limited.** Analysis is its own BullMQ queue (`winnow-ml`),
  so it can be paused, rate-limited and retried independently, and **back-filled**
  over an existing 30k+ library without regenerating a single thumbnail.
- **Suggest, never decide.** Scores feed filters and (later) sort orders. The
  verdict stays the photographer's.

## What ships (Phase 0 + 1)

### Data model

A side table, `asset_analysis` (migration `0017`), keyed by `asset_id`:

| column                | meaning |
|-----------------------|---------|
| `ml_status`           | `pending` / `processing` / `ready` / `error` — lifecycle of the pass, independent of `derivative_status` |
| `ml_error`            | last failure message |
| `sharpness`           | variance of the Laplacian (higher = sharper). **Relative**, not pass/fail |
| `phash`               | 64-bit DCT perceptual hash, 16 hex chars (stored as TEXT — see note) |
| `near_dup_cluster_id` | the near-duplicate cluster this photo belongs to (NULL = no look-alike) |
| `analyzed_at`         | when the scores were computed |

It is a **side table on purpose**: the analysis is optional (an asset works
without it), fully **recomputable** (a heuristic/model upgrade can wipe + rebuild
it without a destructive `ALTER` on the hot `assets` row), and it keeps the wide
`assets` row lean. Mirrors the "materialized attributes" pattern of migration
`0003`, but separate because these values come from a slow, rate-limited pass over
the derivatives, not from the indexer.

> **Why `phash` is TEXT, not BIGINT.** `src/lib/db.ts` installs a global
> int8→JS-number parser (pg type 20). A 64-bit `BIGINT` would silently lose
> precision past 2^53 on the way back to Node. Hex text round-trips losslessly.

Near-duplicate **clusters** get their own structure (`near_dup_clusters` +
`asset_analysis.near_dup_cluster_id`), deliberately **not** the `asset_groups`
machinery used for RAW+JPEG / Live Photo pairs. That machinery means "these files
*are* one logical media" and makes them rate / delete / collapse as a single unit.
Near-duplicates are the opposite — **distinct shots you must choose between** — so
they never collapse a grid tile or cascade a verdict.

### Pipeline

```
derivative ready ──enqueue──► winnow-ml queue ──► runMlAnalysis(assetId)
                                                     │ read PROXY from storage
                                                     │ sharpness + perceptual hash
                                                     │ upsert asset_analysis
                                                     └► assignNearDupCluster()
```

- **Sharpness** — `src/lib/imageScore.ts`: variance of the 3×3 Laplacian over a
  fixed-size greyscale render of the proxy (fixed size so the score is comparable
  across source resolutions). High-frequency energy ≈ in-focus detail. It is a
  **relative** measure — rank within a burst/session — not an absolute verdict: an
  intentional bokeh or motion blur legitimately scores low.
- **Perceptual hash** — the classic 64-bit pHash: 32×32 greyscale → 2-D DCT →
  threshold the 8×8 low-frequency block against its median. Near-identical frames
  yield hashes a few bits apart (small Hamming distance), robust to scaling, mild
  compression and small tonal shifts.
- **Near-duplicate clustering** — `src/lib/neardup.ts`: runs incrementally per
  photo. Two photos in the **same session** join the same cluster when their
  hashes are within `NEAR_DUP_THRESHOLD` Hamming bits; clusters merge transitively.
  Concurrent ML jobs of the same session are serialized with a Postgres advisory
  lock keyed on the session, so the read-modify-write of clusters is race-free
  (different sessions never block each other).

The whole pass is gated by `ML_ENABLED`. When off, no jobs are enqueued and the
worker creates no ML worker.

### Back-fill

On every worker boot, `bootstrapRoots()` enqueues every ready photo that has no
completed analysis (capped per boot; the per-hour rate drips the rest). It reads
proxies only, so it is safe to run repeatedly — an analysed photo stops matching,
so a later boot finds nothing.

### Using it (UI)

The gallery **filter panel** gains two controls, both backed by indexed SQL:

- **Sharpness** range — surface the softest shots (e.g. set a low `max` to review
  blurry candidates for rejection).
- **Near-duplicates** toggle — show only the photos that have look-alikes, with a
  count.

The **Pipeline** page gains an **ML rate** slider (photos analysed per hour,
0 = unlimited), alongside the existing scan/analyze rates. Pausing the pipeline
pauses the ML pass too.

### Configuration

| env | default | meaning |
|-----|---------|---------|
| `ML_ENABLED`         | `true` | turn the whole analysis pass on/off |
| `ML_CONCURRENCY`     | `2`    | parallel ML jobs (bounded, CPU-aware) |
| `NEAR_DUP_THRESHOLD` | `10`   | pHash Hamming distance (0–64) for "near-duplicate"; lower = stricter |

The per-hour throttle (`ml_per_hour`) is a live setting (Pipeline page), not an
env var.

## Roadmap (not yet implemented)

- **Phase 1.x — cluster review surface.** A grid that groups a near-duplicate
  cluster together and lets you keep the best / reject the rest in one gesture
  (the sharpness score picks a default representative). Today the cluster id is
  stored and filterable, but the gallery still shows one tile per photo.
- **Phase 2 — aesthetic scoring.** A pretrained NIMA-style model (ONNX, run via
  `onnxruntime-node` on CPU) producing a 1–10 score, used to **rank within a
  session**. Adds a bundled model to the worker image.
- **Phase 3 — faces & closed eyes.** Face detection + eye-aspect-ratio on
  landmarks to flag closed eyes in portraits. The most CPU-heavy and
  false-positive-prone, and only meaningful for photos of people — hence last.

Each later phase adds its own column(s) to `asset_analysis` via a new migration
and extends the same `winnow-ml` job; the queue, rate-limit, back-fill and filter
plumbing are already in place.
