# 🪶 Winnow — media management tool (ingest / cull / export)

Responsive web app to **index, cull and export** the raw photos/videos from the
NAS, across multiple devices (Sony A7C II, DJI drone, iPhone, Ray-Ban Meta).

> **Guiding principle**: the filesystem and the RAWs are touched only **once**
> (indexing + derivative generation). Everything else — browsing, culling,
> queries — goes through Postgres and a derivative cache. Culling always happens
> on lightweight proxies, **never on the RAWs**.

This repository implements the **MVP** (see §11 of the specs): index + RAW
preview extraction + database + "ignored folder" marking + culling grid (pick/
reject/stars) + "RAW copy for Capture One" export. Photos only.

---

## Architecture

Decoupled components, communicating through Postgres + a Redis queue (BullMQ):

```
NAS (HDD, RAW/video, RO)  ──►  Indexer  ──►  Postgres (sessions, assets, ratings)
                                  │
                                  └─enqueue──►  Derivative workers ──► Storage (disk/MinIO)
                                                   (exiftool + sharp)   thumbs + proxies
Next.js (cull UI + API) ◄── Postgres + Storage
   └─► Export worker ──► RAW copy for Capture One  (+ source→export lineage)
```

Everything (Postgres, Redis, derivatives, exports, inbox) lives on the
**Optiplex**. The NAS sessions that are already filed are mounted **read-only**;
only the `incoming` zone (where imports land) is mounted **read/write**.

### Authentication / access

Auth is handled **upstream** (no application login): **Traefik** (basic-auth)
+ **Cloudflare Tunnel** expose the app behind a domain. Winnow therefore runs on
the internal network and trusts the reverse proxy; do not publish ports
`3000`/`5432`/`6379` directly on the Internet — only Traefik routes to the app.
(For off-LAN mobile access, uploads go through the tunnel.)

### §12 decisions adopted

| # | Decision | Choice |
|---|----------|-------|
| 1 | Derivatives: MinIO or disk | **Disk cache**, behind an S3-style interface (`src/lib/storage`) → switch to **MinIO** via `STORAGE_DRIVER=s3` without touching the code. |
| 2 | Mount vs NAS agent | **RO mount** for the MVP (decided by the specs). |
| 3 | Hash-based deduplication | **Yes from the MVP**: partial `content_hash` (size + endpoints) + unique index. A suspected duplicate is **verified by full-content compare** before being dropped — a false partial-hash collision is indexed anyway (never lost), and every hit is logged in `duplicate_hits` for audit. |
| 4 | Linking key for C1 finals → source | Deferred to V2 (reconciliation), `POST /reconcile` endpoint reserved. |

---

## Getting started

### With Docker Compose (recommended)

```bash
cp .env.dist .env
# Edit NAS_MOUNT (RO sessions) and NAS_INCOMING (RW imports), adjust the paths.
docker compose up -d --build
# `migrate` applies the schema, then app (http://localhost:3000) + worker start.
```

Then, from the UI, enter a NAS folder path (as seen **inside the container**,
e.g. `/nas/2026/…`) and click **Index**.

### Locally (dev)

Requires a reachable Postgres and Redis, plus `perl` (for exiftool) and the
`sharp` libs (provided by the prebuilt binaries).

```bash
npm install
cp .env.dist .env   # adapt DATABASE_URL / REDIS_URL (localhost)
npm run migrate
npm run dev            # UI + API on http://localhost:3000
npm run worker         # in another terminal: BullMQ workers
# Index a folder directly (without Redis):
npm run scan -- /path/to/folder --sync
```

---

## Environment variables

See `.env.dist`. Main ones:

- `DATABASE_URL`, `REDIS_URL`
- `STORAGE_DRIVER=disk|s3`, `STORAGE_DISK_PATH`, and the `S3_*` for MinIO
- `EXPORT_DIR`: folder where the "RAW copy" export drops the originals
- `*_CONCURRENCY`: bounded concurrency to spare the NAS's full HDD
- `THUMB_SIZE` / `PROXY_SIZE` / qualities

---

## API

| Method & route | Role |
|---|---|
| `POST /api/index/scan` `{ path }` | Registers the root and enqueues an indexing run |
| `GET /api/stats` | Counters (media / scan / analyzed / pending) + queue activity + pause + rates |
| `GET /api/settings` · `PATCH /api/settings` `{ scanPerHour?, analyzePerHour? }` | Hourly scan/analyze rates (0 = unlimited) |
| `POST /api/scan/control` `{ action: pause\|resume }` | Suspends/resumes indexing + derivative generation |
| `GET /api/failures` | Everything that failed (scan / analyze / import) + messages |
| `POST /api/failures/retry` `{ kind, ids? }` | Retries failures of a given family |
| `GET /api/assets` `?<filters>&cursor` | Paginated global gallery (cumulative filters) |
| `GET /api/facets` | Values + counts to build the filters |
| `GET /api/sessions` | List of sessions + counters (ready/pending/picks) |
| `PATCH /api/sessions/:id` `{ ignored }` | Marks the folder as handled (cascade, stops derivatives) |
| `GET /api/sessions/:id/assets?cursor&verdict&…` | Paginated grid (cursor-based) |
| `GET /api/assets/:id` | Detail + EXIF |
| `GET /api/assets/:id/thumb` \| `/proxy` | Serves the derivative (bytes, or signed redirect on S3) |
| `GET /api/assets/:id/exports` | Lineage (finals linked to this original) |
| `PATCH /api/assets/:id/rating` `{ verdict, star, color }` | Cull state |
| `POST /api/ratings/bulk` `{ ids[], verdict, star }` | Quick bulk culling |
| `POST /api/assets/delete` `{ ids[], restore? }` | Soft delete / restore (hides from the library, RAW untouched) |
| `POST /api/tags/assign` `{ ids[], add?, remove? }` | Add/remove tags (single via `ids:[id]`, or bulk) |
| `POST /api/export` `{ name, target, filter }` | Creates + enqueues an export (`filter.ids` exports a precise selection) |
| `GET /api/export/:id` | Status + result |
| `POST /api/upload` (multipart `files`) | Upload from the phone → inbox → import |
| `POST /api/import/offload` `{ path }` | Offload from a mounted card (source kept) |
| `POST /api/import/inbox` | Manual re-trigger of the inbox import |
| `GET /api/import/:id` | Status of an import batch |
| `GET /api/roots` · `POST /api/roots` | Registered folders (sources + finals) |
| `POST /api/reconcile` | Finals→sources reconciliation (**V2**, 501) |

**Cursor-based** pagination on `(captured_at, id)` — never an `OFFSET`. The
front-end grid infinite-scroll-loads the thumbnails as they come.

### Culling shortcuts (viewer)

- **Keyboard**: `P` pick · `X` reject · `U` undo · `1`-`5` stars · `←`/`→` navigate · `Esc` close
- **Touch**: swipe ↑ = pick, swipe ↓ = reject, swipe ←/→ = navigate

### Image actions (delete · tag · export · pick · reject · rate)

The same set of actions is reachable from three surfaces, all backed by the
shared endpoints above (`AssetActionMenu` + `lib/assetActions.ts`):

- **Right-click a thumbnail** (gallery + session grids) → context menu with the
  full set (pick / reject / clear · stars · tag · export · delete).
- **Detailed viewer** → already has pick / reject / stars / tag; the two missing
  ones — **export** and **delete** — are added to the control bar.
- **Bulk selection** (gallery *Select* mode) → pick / reject / stars, add/remove
  tag, export and delete applied to the whole selection.

**Delete is a soft delete** (guiding principle: the RAWs are touched only once).
It sets `assets.deleted_at` so the file is hidden from every listing/export but
the original on the NAS is never modified; it's reversible
(`POST /api/assets/delete { ids, restore: true }`). **Export** queues a normal
RAW-copy job scoped to exactly the chosen ids.

### Global gallery & cumulative filters

**Gallery** page: **virtualized** grid (react-window — only the visible rows are
in the DOM, handles 30k+) over **all** the assets, with a **cumulative** filter
panel (combined with AND):

- **Calendar**: year / month / day (multi-select) + date range
- **Device / EXIF**: device, camera model, lens (multi); ISO, focal length,
  aperture ranges
- **Type / format**: photo·video, extension (multi)
- **Size** (MB range), **GPS** present, **verdict**, **min rating**

These dimensions are **materialized and indexed in the database** (migration
0003: `capture_year/month/day/date` populated by trigger + indexes on device,
ext, media_type, file_size, camera_model, lens, iso, focal_length, aperture).
The available values/counts come from `GET /api/facets`; filtering is therefore
100% indexed SQL, with no on-the-fly computation.

---

## Pipeline control (scan / analyze)

The dashboard (home page) exposes a **control panel** and a **stats bar**
refreshed every 5 s (`GET /api/stats`):

- **Counters**: number of indexed **media**, **scan** (folders in the indexing
  queue), **analyzed** (derivatives ready), **pending** (to analyze), plus
  errors — to see at a glance what's left to do.
- **Pause / resume**: suspends indexing **and** derivative generation
  (`POST /api/scan/control`). The pause is persisted in Redis (`queue.pause()`)
  *and* via a database flag, read by the indexer to stop **mid-scan**; resuming
  re-enqueues the roots to finish an interrupted scan (incremental: already-known
  files are skipped).
- **Hourly rates** (sliders): max number of files **scanned** and derivatives
  **analyzed** per hour (`PATCH /api/settings`, `0 = unlimited`). Spread out
  drip-by-drip via a shared Redis limiter — useful to spare the NAS's full HDD
  without blocking the app.
- **Incoming / inbox priority**: imports (incoming) and the inbox go **ahead** of
  ordinary scans/derivatives (BullMQ priority). A long ordinary scan is
  **preempted** as soon as an incoming scan is waiting, then re-enqueued.

## Video derivatives (ffmpeg)

Videos get derivatives like photos: **WebP poster** (grid thumbnail) + **H.264
mp4 proxy** that's playable/seekable in the viewer (service route with **Range
requests**). The worker image bundles `ffmpeg`.

**Hardware acceleration (optional)**: `VIDEO_HWACCEL=vaapi` encodes on the Intel
iGPU (share `/dev/dri` with the worker container — already wired in
`docker-compose-optiplex.yml`). Hardware encoding fails? **automatic fallback**
to software libx264. Defaults to `none` (software) → works everywhere.

## Failures: list + retry (page `/failures`)

Everything that failed is listed in one place, with the **error message** to
debug, and a **"retry"** button per family:

- **Analyze** (derivatives): `assets.derivative_status='error'` — *retroactive*.
- **Scan** (indexing): `scan_failures` table (per-file failure) — from now on;
  previously only a counter existed, nothing was persisted.
- **Import**: per-file errors of the batches (`import_batches.result`) — *retroactive*.
  Failed files are **quarantined** (`inbox/.failed/`) so they stop looping;
  retrying re-imports them.

## Scope & next steps

**Implemented (MVP)**: incremental indexing (mtime+size), EXIF + hash + dedup,
RAW preview extraction (ARW/DNG…) without demosaicing, **HEIF/HEVC decode**
(`.heic`/`.heif`/`.hif` — iPhone & Sony A7C II/Canon — via libheif, since sharp's
prebuilt libvips only ships the AVIF decoder), thumb/proxy derivatives
in WebP, mobile-first culling grid, ignore-cascade, RAW-copy export + `exports`
lineage, **multi-feeder ingest** (see below), **virtualized gallery with
cumulative filters** (DB-indexed attributes), **pipeline control** (pause/resume,
incoming/inbox priority, adjustable scan/analyze rates, real-time counters — see
below), **video derivatives** (poster + ffmpeg mp4 proxy, optional VAAPI hardware
acceleration), **failure list/retry** (page `/failures`), GitHub Actions **CI**
(typecheck + migrations + build).

**V2/V3 (not included)**: advanced ratings/colors/tags, web export + Immich push,
automatic C1 finals reconciliation, adaptive throttling, agent-on-NAS, n8n
automations.

---

## Ingest / import (implemented)

The specs assume files are **already filed on the NAS**. Winnow adds an import
stage upstream: **all feeders converge to an `inbox`**, then an *import worker*
**verifies** (write-then-verify by hash), **deduplicates** (same `content_hash`
as the indexer → re-inserting a card duplicates nothing), **files** into
`incoming` (NAS archive) following the `{device}/{YYYY}/{YYYY-MM-DD}/` template,
then enqueues the usual indexing.

```
 iPhone / Ray-Ban ─┐
 SD card (Sony/DJI)─┼─►  INBOX  ──►  Import worker  ──►  INCOMING (NAS, RW)  ──► index → derivatives
 Wi-Fi/FTP camera ──┘     (watch)    verify+dedup+file     {device}/{date}/
```

**Three feeders, all wired to the inbox:**

1. **Web upload (phone)** — **Import** page in the UI: native file picker, the
   media are streamed to `POST /api/upload`, dropped in the inbox, then imported.
   No third-party app, works from the phone on the LAN. (HEIC/JPEG/video
   supported.)

2. **Offload of a card mounted on the Optiplex** — `POST /api/import/offload
   { path }` (or the dedicated field on the Import page). The card is **left
   intact** (`removeAfter=false`).

3. **SMB / FTP drop** — a Samba share and/or an FTP endpoint (optional services
   in `docker-compose.yml`) write into the inbox; a **watcher** (chokidar,
   `awaitWriteFinish` so a transfer in progress isn't imported) enqueues the
   import automatically. Ideal for the Sony A7C II's FTP transfer.

**Guarantees**: verified integrity (size + hash of the copy), global dedup
(false partial-hash collisions are caught by a full-content compare, so a
distinct shot is never silently discarded; all hits land in `duplicate_hits`),
deterministic foldering, per-batch tracking in `import_batches` (imported /
duplicates / failures). It all reuses the existing indexer, derivatives and dedup.

**Inbox vs incoming**: the `inbox` (fast local disk) is a **transient staging
area** (emptied after import); `incoming` (NAS, RW) is the **permanent filed
archive**. They are not duplicates: during import, both copies coexist for the
duration of the verification (write-then-verify), then the inbox is cleaned. Two
**hidden** subfolders of the inbox (ignored by the watcher and the walk):
`.uploads/` (staging for web uploads, imported as a batch — avoids the double
trigger watcher + import) and `.failed/` (**quarantine** for failed files, so
they stop looping; retriable from `/failures`).

**V2/V3 ideas**: grouping by "time gap" (gap > N h ⇒ session), configurable
foldering template, n8n trigger on card insertion, full hash (instead of partial)
as an option for strong integrity — note the silent-loss risk of the partial
hash is already mitigated: collisions are verified by a full-content compare and
audited in `duplicate_hits`, so a full-hash default would be an optimization, not
a correctness fix.
