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

Then, from the **Volumes** page, **+ Add folder** — enter a NAS path (as seen
**inside the container**, e.g. `/nas/2026/…`) and pick its **type**
(Incoming / Final / Export). See [Volumes](#volumes-directories-attached-to-the-project).

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

### With Docker, fully local (dev, hot reload)

To run the whole stack on your machine **without pointing at the remote NAS**,
use the `docker-compose.dev.yml` override. It bind-mounts the source (live
edits, no rebuild), runs `next dev` / `tsx watch`, and maps the three "NAS"
mounts to **local folders** (`./nas`, `./nas-incoming`, `./nas-final`) whatever
`NAS_*` says in `.env`. Postgres, Redis and all other state stay in local Docker
volumes — nothing remote is involved.

```bash
cp .env.dist .env   # keep DATABASE_URL / REDIS_URL as-is (compose service names)
# First run builds the image (system deps + npm ci); afterwards code changes
# hot-reload and only package.json changes need another --build.
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Drop a few sample RAW/JPEG/MP4 into `./nas`, then in the UI (http://localhost:3000)
go to **Volumes → + Add folder** and enter the path **as seen inside the
container** (e.g. `/nas/2026/…`). `./nas`, `./nas-incoming`, `./nas-final` and
`./data` are git-ignored (Docker auto-creates them on first `up`).

> The standalone (non-dev) `docker compose up` reads `NAS_MOUNT` / `NAS_INCOMING`
> / `NAS_FINAL` from `.env`. To point *that* at local dirs instead of the NAS,
> set those three variables to local paths (or remove them to fall back to the
> `./nas*` defaults baked into `docker-compose.yml`).

---

## Environment variables

See `.env.dist`. Main ones:

- `DATABASE_URL`, `REDIS_URL`
- `STORAGE_DRIVER=disk|s3`, `STORAGE_DISK_PATH`, and the `S3_*` for MinIO
- `EXPORT_DIR`: folder where the "RAW copy" export drops the originals
- `*_CONCURRENCY`: bounded concurrency to spare the NAS's full HDD
- `THUMB_SIZE` / `PROXY_SIZE` / qualities

The whole environment is validated **once at startup** by a Zod schema in
`src/lib/config.ts`. A missing/garbled/incoherent variable (a typo'd
`STORAGE_DRIVER`, a non-numeric `*_CONCURRENCY`, `STORAGE_DRIVER=s3` without
the `S3_*` credentials…) fail-fasts the process with a message listing every
offending variable — instead of silently degrading in production.

---

## API

| Method & route | Role |
|---|---|
| `POST /api/index/scan` `{ path }` | Registers the root and enqueues an indexing run |
| `GET /api/stats` | Counters (media / scan / analyzed / pending) + queue activity + pause + rates |
| `GET /api/settings` · `PATCH /api/settings` `{ scanPerHour?, analyzePerHour? }` | Hourly scan/analyze rates (0 = unlimited) |
| `POST /api/scan/control` `{ action: pause\|resume }` | Suspends/resumes indexing + derivative generation |
| `GET /api/failures` | Everything that failed (scan / analyze / import) + the deduplication audit (each duplicate joined to its kept asset for thumbnail/compare) |
| `POST /api/failures/retry` `{ kind, ids? }` | Retries failures of a given family |
| `GET /api/failures/duplicates/file` `?path=` | Streams a recorded duplicate's raw file (whitelisted to `duplicate_hits`) so an unindexed extra copy can be inspected locally |
| `POST /api/failures/duplicates/delete` `{ paths[] }` | Hard-deletes extra copies recorded in `duplicate_hits` (whitelisted · never an indexed asset · confined to the browsable area) and clears their audit rows |
| `POST /api/failures/duplicates/keep` `{ contentHash, keepPath }` | Collapses a group of byte-identical copies to the single survivor the user picked. Keeping an on-disk copy **relinks** the library asset onto it (id/rating/tags/derivatives preserved) and deletes the former original; keeping the indexed copy just removes the recorded extras. False collisions are never eligible |
| `GET /api/pipeline/queue` `?name=scan\|analyze` | Live jobs of the scan/analyze queue, enriched with the root/asset they point at |
| `POST /api/pipeline/queue/remove` `{ name, jobId }` | Removes one job from the scan/analyze queue (active jobs can't be removed mid-flight) |
| `GET /api/assets` `?<filters>&cursor&sort=recent` | Paginated global gallery (cumulative filters incl. `derivative_status` and `q=` free-text path search; `sort=recent` orders by last update) |
| `GET /api/assets/geo` `?<filters>` | GPS points (`{id,lat,lon}`) of the geotagged matches — feeds the map view |
| `GET /api/facets` | Values + counts to build the filters |
| `GET /api/sessions` | List of sessions + counters (ready/pending/picks) |
| `PATCH /api/sessions/:id` `{ ignored }` | Marks the folder as handled (cascade, stops derivatives) |
| `DELETE /api/sessions/:id` `?files=true` | Deletes the session (cascade: assets/ratings/picks) + its derivative cache. `files=true` also removes the originals from disk (incoming only, confined to the session folder) — to clear an orphaned import |
| `GET /api/sessions/:id/assets?cursor&verdict&…` | Paginated grid (cursor-based) |
| `GET /api/assets/:id` | Detail + EXIF |
| `GET /api/assets/:id/thumb` \| `/proxy` | Serves the derivative (bytes, or signed redirect on S3) |
| `GET /api/assets/:id/exports` | Lineage (finals linked to this original) |
| `PATCH /api/assets/:id/rating` `{ verdict, star, color }` | Cull state |
| `POST /api/ratings/bulk` `{ ids[], verdict, star }` | Quick bulk culling |
| `POST /api/assets/delete` `{ ids[] \| filter, restore? }` | Soft delete / restore — the recycle bin (hides from the library, RAW untouched). `filter` deletes/restores in bulk, e.g. `{ verdict:"reject" }` |
| `GET /api/trash` | Trash summary: reclaimable count/bytes, rejects still in the library, recent purges |
| `POST /api/purge` `{ filter?, dryRun? }` | **Reclaim space**: physically removes the trashed originals + derivatives (queued job). `dryRun` returns `{ count, bytes }` to free. Only ever touches soft-deleted assets |
| `POST /api/assets/regenerate` `{ ids[] }` | Rebuilds the derivatives (thumb + proxy) of a selection — re-enqueues generation whatever the current status |
| `POST /api/assets/skip` `{ ids[] }` | Takes assets out of the analyze pipeline (`derivative_status` → `skipped`); honoured even by an already-queued job |
| `POST /api/tags/assign` `{ ids[], add?, remove? }` | Add/remove tags (single via `ids:[id]`, or bulk) |
| `POST /api/export` `{ name, target, filter }` | Creates + enqueues an export (`filter.ids` exports a precise selection) |
| `GET /api/export/:id` | Status + result |
| `POST /api/upload` (multipart `files`) | Upload from the phone → inbox → import |
| `POST /api/import/offload` `{ path }` | Offload from a mounted card (source kept) |
| `POST /api/import/inbox` | Manual re-trigger of the inbox import |
| `GET /api/import/:id` | Status of an import batch |
| `GET /api/roots` · `POST /api/roots` `{ path, type }` | Registered volumes (+ session/asset counts); `type` ∈ incoming·final·export, path-guarded |
| `PATCH /api/roots/:id` `{ type?, watch?, reindex? }` · `DELETE /api/roots/:id` | Re-type / re-index / remove a volume (remove cascades to its index, files untouched) |
| `GET /api/fs` `?path=<dir>` | Subdirectories of `<dir>` for the folder picker — confined to the browse roots (`BROWSE_ROOTS` + the volume dirs); omit `path` for the starting locations |
| `POST /api/reconcile` | Finals→sources reconciliation (**V2**, 501) |

**Cursor-based** pagination on `(captured_at, id)` — never an `OFFSET`. The
front-end grid infinite-scroll-loads the thumbnails as they come.

### Culling shortcuts (viewer)

- **Keyboard**: `P` pick · `X` reject · `U` undo · `1`-`5` stars · `←`/`→` navigate · `Esc` close
- **Touch**: swipe ↑ = pick, swipe ↓ = reject, swipe ←/→ = navigate

### Image actions (delete · tag · export · regenerate · pick · reject · rate)

The same set of actions is reachable from three surfaces, all backed by the
shared endpoints above (`AssetActionMenu` + `lib/assetActions.ts`):

- **Right-click a thumbnail** (gallery + session grids) → context menu with the
  full set (pick / reject / clear · stars · tag · export · **regenerate
  derivatives** · delete).
- **Detailed viewer** → pick / reject / stars / tag plus **export**,
  **regenerate derivatives** and **delete** in the control bar. The info panel
  surfaces the full metadata (date, size, dimensions + megapixels, duration for
  video, device, GPS with a map link, derivative status, file path).
- **Bulk selection** (gallery *Select* mode) → pick / reject / stars, add/remove
  tag, export, **regenerate derivatives** and delete applied to the whole
  selection.

**Delete is a soft delete** — the **recycle bin**, not the end of the road. It
sets `assets.deleted_at` so the file is hidden from every listing/export but the
original on the NAS is untouched and fully recoverable
(`POST /api/assets/delete { ids, restore: true }`). Reclaiming the space is a
**separate, confirmed** step (the **Trash** tab → *Empty trash*); see
[Reclaiming space](#reclaiming-space-the-winnowing). **Export** queues a normal
RAW-copy job scoped to exactly the chosen ids. **Regenerate derivatives**
re-enqueues thumb/proxy generation for the selection (resets them to `pending`
whatever the current status) — handy after a worker/codec upgrade or a bad
preview; the RAW is read again but never modified.

### Reclaiming space (the winnowing)

Sorting (pick/reject/stars) is only half of *winnowing* — the point is to
actually **slim the archive down**. Winnow does this in two deliberate stages so
nothing is ever lost by accident:

1. **Recycle bin (soft delete)** — *Delete* (gallery / viewer / bulk), or *Move
   all rejects to trash* in the **Trash** tab, sets `deleted_at`. The shots
   vanish from the library but the originals stay on the NAS, recoverable
   (per-item *Restore* or *Restore all*).
2. **Reclaim (purge)** — *Empty trash* asks for an explicit confirmation, then
   queues a **purge job** that physically removes the trashed originals **and**
   their cached derivatives, freeing the disk. The asset *row* is kept (audit +
   export lineage): `purged_at` marks the bytes as gone, logged in `purge_log`.

The purge runs on the worker with **bounded concurrency** (`PURGE_CONCURRENCY`,
spares the HDD) and is **resilient**: a file already gone counts as reclaimed; a
file that can't be removed (e.g. a **read-only mount**, so the filed NAS sessions
must be mounted read/write to be freed) keeps its place in the trash with the
reason recorded — nothing else is touched, and you can retry. Disable the whole
capability with `PURGE_ENABLED=false`. The **Trash** tab shows the reclaimable
size up front and the result of each purge (freed bytes, anything that failed).

### Global gallery & cumulative filters

**Gallery** page: **virtualized** grid (react-window — only the visible rows are
in the DOM, handles 30k+) over **all** the assets, with a **cumulative** filter
panel (combined with AND):

- **Search** (`q=`): free-text over the file path — **filename and folder**.
  Whitespace splits the query into tokens, each an AND substring match
  (case-insensitive). Debounced field at the top of the filter panel; mirrored
  to the URL like every other filter.
- **Calendar**: year / month / day (multi-select) + date range
- **Device / EXIF**: device, camera model, lens (multi); ISO, focal length,
  aperture ranges
- **Type / format**: photo·video, extension (multi)
- **Size** (MB range), **GPS** present, **verdict**, **min rating**
- **Live Photos** (`group_kind=live_photo`): show only iPhone Live Photos (the
  still + `.mov` pairs)

These dimensions are **materialized and indexed in the database** (migration
0003: `capture_year/month/day/date` populated by trigger + indexes on device,
ext, media_type, file_size, camera_model, lens, iso, focal_length, aperture).
The available values/counts come from `GET /api/facets`; filtering is therefore
100% indexed SQL, with no on-the-fly computation. The `q=` text search matches
`rel_path` (which carries both the folder and the filename) and stays fast on a
large library via **trigram GIN indexes** (`pg_trgm`, migration 0010).

### Map view (where the media are) & zone culling

Every gallery (Incoming → *Browse*, *Final*, and `/gallery`) has a **Grid / Map**
toggle. The **Map** plots one point per geotagged asset — so you can *see where
the media are* — over OpenStreetMap tiles (source configurable via
`NEXT_PUBLIC_MAP_TILE_URL`). The points respect the current cumulative filters
(device, date, type…), and `GET /api/assets/geo` returns just `{id,lat,lon}` so
even a large library plots in one request (capped, with a `truncated` flag).

**Pick a zone, then act on it.** Either **Select visible area** (use the current
viewport — works on touch too) or **Draw box** (drag a rectangle). The map shows
how many media fall in the zone and lets you **Pick · Reject · Export** them in
one go, or **Show in grid** to review the thumbnails. A clicked point pops its
thumbnail. The zone is just a **bounding box** that becomes a regular cumulative
filter (`bbox=w,s,e,n`), materialized + indexed in the DB (migration 0010:
`gps_lat`/`gps_lon` populated by trigger from the `gps` JSONB), so it stacks with
every other filter and scopes the grid, the selection, and exports — the picks
that drop into Capture One are exactly the media from that area.

---

## Volumes (directories attached to the project)

The dedicated **Volumes** page (`/volumes`, in the rail) is the registry of every
directory Winnow indexes or tracks — a **table** with one row per folder, its
**type**, the **session/media counts**, and per-row actions (**re-index**,
**remove**). It replaces the old free-text "index this path" field on the
Library tab (which made it far too easy to scan `/` — a recursive walk has no
depth limit or boundary, so that pulled in the whole filesystem, finals
included).

- **Type** decides how a folder is interpreted (maps to `roots.kind`):
  **Incoming** (`source`, cullable), **Final** (`finals`, view-only), **Export**
  (`export`, *listed for visibility only — never walked*). Editable inline.
- **Add folder** opens a modal with a **server-side folder picker** (`GET
  /api/fs`): browse the NAS and click a folder instead of typing a path —
  navigating into a folder also selects it. Navigation is **confined to the
  browse roots** (`BROWSE_ROOTS`, default `/nas`, plus the configured volume
  dirs), so the OS tree (`/etc`, `/usr`, …) is never reachable and symlinks
  can't escape the bounds. An **Enter path** tab keeps manual entry as a
  fallback. Either way a **type selector** decides how the folder is treated,
  and the same guards (reject `/` and system dirs, refuse a path that
  **overlaps** an existing volume) back `POST /api/index/scan` and
  `POST /api/roots`.
- **Origin** badge (`env` / `manual`): the four env vars
  (`INCOMING_DIR` / `FINALS_DIRS` / `EXPORT_DIR`) **seed** volumes at worker
  bootstrap and suggest the type per directory; the table is the editable source
  of truth on top. `FINALS_DIRS` is already a list, so several final folders are
  supported today — the table simply makes them visible.
- **Remove** deletes the volume + its sessions/assets/ratings from the DB
  (`ON DELETE CASCADE`); the originals on the NAS are never modified (Winnow only
  reads). An env-seeded volume reappears on the next worker bootstrap.

## Pipeline control (scan / analyze)

The dedicated **Pipeline** page (`/pipeline`, in the rail) exposes the full
**control panel** + **stats bar**, refreshed every 5 s (`GET /api/stats`). The
Library header keeps only a **compact stats strip** (value+label chips on
desktop; a single summary chip that opens the detail in a popover on phones, so
the bento no longer eats half the screen) — each counter links through to its
dedicated Pipeline triage page:

- **Counters**: number of indexed **media**, **scan** (folders in the indexing
  queue), **analyzed** (derivatives ready), **pending** (to analyze), plus
  **failures** (always shown) — to see at a glance what's left to do.
- **Triage sub-pages** (tabs under `/pipeline`): each counter has its own page
  with a **live, actionable list**:
  - **Media** (`/pipeline/media`) — every indexed asset; open the full preview or
    soft-delete (the RAW original is never touched).
  - **Scanning** (`/pipeline/scanning`) — the live scan queue; **remove** a
    stuck/unwanted folder job (active scans can't be removed mid-flight).
  - **Pending** (`/pipeline/pending`) — media awaiting analysis; **regenerate**,
    **skip** (take it out of the pipeline — honoured even by an already-queued job)
    or remove.
  - **Analyzed** (`/pipeline/analyzed`) — latest derivatives processed; re-create
    a bad preview or remove the media.
  - **Failures** (`/pipeline/failures`) — see below.
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
- **Scan coalescing**: indexing is incremental + idempotent, so every trigger
  (bootstrap, import, resume, retry, preemption…) **coalesces** on the root id —
  at most **one pending scan per root**. A more urgent request **promotes** the
  queued job's priority instead of stacking a duplicate, and the worker
  reconciles any leftover duplicates at startup. This stops the same folder from
  piling up several times in the scan queue.

## Video derivatives (ffmpeg)

Videos get derivatives like photos: **WebP poster** (grid thumbnail) + **H.264
mp4 proxy** that's playable/seekable in the viewer (service route with **Range
requests**). The worker image bundles `ffmpeg`.

**Hardware acceleration (optional)**: `VIDEO_HWACCEL=vaapi` encodes on the Intel
iGPU (share `/dev/dri` with the worker container — already wired in
`docker-compose-optiplex.yml`). Hardware encoding fails? **automatic fallback**
to software libx264. Defaults to `none` (software) → works everywhere.

## Failures: list + retry (page `/pipeline/failures`)

Everything that failed is listed in one place, with the **error message** to
debug, and a **"retry"** button per family:

- **Analyze** (derivatives): `assets.derivative_status='error'` — *retroactive*.
- **Scan** (indexing): `scan_failures` table (per-file failure) — from now on;
  previously only a counter existed, nothing was persisted.
- **Import**: per-file errors of the batches (`import_batches.result`) — *retroactive*.
  Failed files are **quarantined** (`inbox/.failed/`) so they stop looping;
  retrying re-imports them.
- **Deduplication** (audit + triage): copies of the same bytes are **grouped by
  content**. Each group lists *every* place that content lives — the library's
  indexed copy (its thumbnail stands in for the group) and any extra copies on
  disk — making no assumption about which is "the original". The user picks the
  survivor with **Keep only this**: the rest are hard-deleted and, when the
  survivor is an on-disk copy, the library asset is **relinked** onto it (its id,
  rating, tags and derivatives are preserved — the bytes are identical), so a
  single media remains. Other hands-on actions: **filter by path** (e.g. `trash`
  to isolate Capture One's trash folder), **download** any copy to verify it, and
  **delete** on-disk extras one at a time or by selection. Everything is behind a
  confirmation and guarded: file deletes are confined to the browsable area, only
  ever touch a recorded copy or the relinked-away original, and a **false
  collision** (distinct content that merely shares a partial hash) is never
  grouped, collapsed, or deletable — it's indexed on its own and listed apart for
  audit only.

## Backups & restore

The RAWs are mounted **read-only** and never lost, but every bit of curation —
verdicts, stars, tags, soft-deletes, the indexed facets and the source→export
**lineage** — lives **only in Postgres**. So the database is the one piece of
state that needs a backup.

A `backup` sidecar (in both compose files) runs next to Postgres and, on a
schedule (default **daily**, `BACKUP_INTERVAL`), takes a compressed `pg_dump`,
names it `winnow-<UTC timestamp>.sql.gz`, and prunes dumps older than
`BACKUP_KEEP_DAYS` (default 14). It shares the `postgres:16-alpine` image, so the
dump tool always matches the server. Dumps land in `./backups` (dev) or
`${WINNOW_DATA:-/opt/winnow}/backups` (Optiplex).

```bash
docker compose logs -f backup            # watch it run
./scripts/pg-backup.sh                    # ad-hoc dump (e.g. before a migration)
./scripts/pg-restore.sh ./backups/winnow-<ts>.sql.gz   # restore (stop app/worker first)
```

Full schedule/retention config, the host-cron alternative, **off-box copy**
guidance (the Optiplex dumps sit on the same disk as `pgdata` — copy them to the
NAS for disk-failure durability) and the **step-by-step restore procedure** are
in **[`docs/BACKUP.md`](docs/BACKUP.md)**.

## Progressive Web App (install on phone / desktop)

Winnow ships as an installable PWA, so the culling grid runs full-screen from a
home-screen icon on **Android/Chrome**, **iOS/iPadOS (Safari)** and desktop
**Chrome/Edge** — no app store.

- **Manifest** — generated by Next.js at `/manifest.webmanifest`
  ([`src/app/manifest.ts`](src/app/manifest.ts)): standalone display, paper
  theme/splash colours, `start_url` = `/library`, app shortcuts (Library /
  Gallery / Import).
- **Icons** — [`public/icons`](public/icons): `any` + `maskable` PNGs (192/512),
  a 180px `apple-touch-icon` for iOS, and SVG/favicons. Re-rasterise from the SVG
  sources with `npx tsx scripts/gen-icons.ts` after editing
  [`public/icons/icon.svg`](public/icons/icon.svg).
- **Service worker** — [`public/sw.js`](public/sw.js), registered in production
  only by [`ServiceWorkerRegister`](src/app/ServiceWorkerRegister.tsx). It makes
  the app installable, serves the build shell stale-while-revalidate, and shows
  [`public/offline.html`](public/offline.html) when a navigation can't reach the
  network. It deliberately **never caches `/api` responses or media bytes**
  (thumb/proxy/download) — those are large and volatile and always hit the
  network.

> Installability and the service worker require a **secure context** (HTTPS, or
> `localhost` for testing). Serve Winnow over TLS behind your reverse proxy to
> get the install prompt on phones.

**To install:** Android/desktop Chrome → "Install app" from the address bar /
menu. iOS Safari → Share → "Add to Home Screen".

## Scope & next steps

**Implemented (MVP)**: incremental indexing (mtime+size), EXIF + hash + dedup,
RAW preview extraction (ARW/DNG…) without demosaicing, **HEIF/HEVC decode**
(`.heic`/`.heif`/`.hif` — iPhone & Sony A7C II/Canon — embedded preview first,
otherwise libheif, since sharp's prebuilt libvips only ships the AVIF decoder;
the decoder is lazy-loaded and serialized so it can never crash the worker),
thumb/proxy derivatives
in WebP, mobile-first culling grid, ignore-cascade, **media pairing** (RAW+JPEG
siblings tied by basename, **iPhone Live Photos** tied by Apple's Content
Identifier — the pair shows, rates, soft-deletes and exports as one logical
media; the viewer's segmented toggle swaps to the RAW source or plays the Live
Photo's `.mov` motion), RAW-copy export + `exports`
lineage, **reclaim space** (recycle-bin soft-delete → confirmed purge that frees
the NAS originals + derivatives, with audit + per-file resilience),
**multi-feeder ingest** (see below), **virtualized gallery with
cumulative filters** (DB-indexed attributes), **map view** (plot geotagged media,
select a zone → pick/reject/export the area), **pipeline control** (pause/resume,
incoming/inbox priority, adjustable scan/analyze rates, real-time counters — see
below), **video derivatives** (poster + ffmpeg mp4 proxy, optional VAAPI hardware
acceleration), **failure list/retry** (page `/pipeline/failures`), **scheduled
Postgres backups** (compressed `pg_dump` sidecar + retention + documented
restore, see [`docs/BACKUP.md`](docs/BACKUP.md)), GitHub Actions **CI**
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
