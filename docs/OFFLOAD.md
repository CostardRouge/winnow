# Offload — memory cards to the NAS without Finder

*Written 2026-09-29 as a design brief, with nothing agreed and nothing built.
It answers the question the maintainer asked — what could run on the Mac to
replace the hand-made card offload — and stops before the web import, which is
the next conversation (§10 says what carries over). Everything marked **open**
is the maintainer's call; §12 lists those calls in the order they block.*

---

## 1. The flow today, and what it already gets right

As the maintainer described it:

1. The Sony (A7C II) and DJI cards go into one SD + microSD reader on the Mac;
   both show up in Finder.
2. Each card folder is renamed after its shoot, the camera's own name kept as a
   prefix: `100MSDCF` → `100MSDCF Tour Eiffel`.
3. The renamed folders are copied by hand into `captures` on the Synology — the
   share the Optiplex mounts read-write as `/nas-incoming`, i.e. Winnow's
   Incoming root (`INCOMING_DIR`, `docker-compose-optiplex.yml`).
4. Winnow notices on its next periodic rescan (`rescanMinutes`, 60 by default)
   and indexes.

The iPhone and the Ray-Ban Meta have no card: the glasses hand their media to
the iPhone through the Meta AI app, so both are one source, the phone's library
(§10).

The web import (Settings › Import) is under-used, and the code says why: it
files every import under `{device}/{YYYY}/{YYYY-MM-DD}/`, hardcoded
(`src/lib/import.ts:76`). `docs/SETTINGS-UI.md` E21 predicted it — "the one
most likely to stop someone using the import path at all". The name given to
the shoot is thrown away. Its other card path, *Card mounted on the server*,
wants the card inside the Optiplex.

**Two things the hand-made flow gets right, which any replacement must keep:**

- **The name is final before the bytes land.** Renaming a folder Winnow has
  already indexed is a move, and a move deadlocks the pipeline
  (`docs/memory/pipeline.md`, "A moved original deadlocks the pipeline"): the
  renamed files are dropped as unverifiable duplicates of rows whose paths no
  longer exist, those rows are auto-trashed, and no rescan heals it. *Failures ›
  Missing files › Moved, not deleted* repairs it after the fact; nothing
  prevents it.
- **One folder holds one card's shoot.** The `100MSDCF` / `DJI_001` prefix keeps
  the Sony and the drone apart even when they shot the same outing, and three
  things in Winnow lean on that without saying so. The device vote's strongest
  signal is "the busiest body of the SAME folder" (`lib/deviceAttribution.ts`,
  weight 3), so a folder mixing A7C II stills and drone clips could propose the
  A7C II for the clips, pre-ticked. Unplaced was designed on the observed fact
  that one folder = one memory card (`docs/UNPLACED.md` §4.4). And RAW+JPEG
  pairing is by basename within a folder (`lib/pairing.ts`), so two cards
  poured into one folder either collide on `DSC00123` or need a renaming that
  keeps pairs together (§6.4).

## 2. What goes wrong today (verified in the code)

1. **A file can be indexed half-written.** Winnow waits for a write to finish
   only in the *inbox* (`lib/watcher.ts`, chokidar `awaitWriteFinish`). Incoming
   is walked with no such guard, and Finder writes under the final name, so a
   rescan that ticks during a copy hashes and reads truncated files and
   enqueues derivatives for them. It mostly heals — the finished file's
   size/mtime differ, so the next scan re-indexes it — at the cost of failed
   derivative jobs. In one corner it does not: if the finished file is a
   duplicate of something already held, the UPDATE hits the `content_hash`
   unique index and the file lands in scan failures instead of the dedup log.
   Rare today (a 40 GB copy is ~6 min at gigabit, against an hourly tick), but
   it is a race, not a rule.
2. **Nothing says a card is safe to format.** Which shoots are already on the
   NAS lives in the maintainer's head. A card not formatted between two outings
   has to be diffed by eye.
3. **A Sony card holds files Winnow must not see.** Copied whole,
   `PRIVATE/M4ROOT/THMBNL/C0001T01.JPG` thumbnails are indexed as photos and
   `SUB/` proxy clips (proxy recording) as separate videos: `classifyExt` knows
   `.jpg` and `.mp4`, not which folder they came from. Only `CLIP/` and its
   `M01.XML` sidecars are media. (DJI's `.LRF` proxies are harmless — not a
   recognized extension.)
4. **A card mounted read-write gets written to** — `.Spotlight-V100`,
   `.fseventsd`, `._*` AppleDouble files. And if step 2 of §1 happens *on the
   card* (**open**), the renamed folder no longer follows the DCF naming the
   camera expects of its own `DCIM` folders; a body may ignore it or offer to
   rebuild its image database.

## 3. Goals and non-goals

**Goals**: insert a card → see what is new on it, grouped by shoot → name each
group, or accept a default → one verified copy per group into `captures`,
invisible to Winnow until complete → Winnow indexes it now rather than within
the hour → a notification that says, in words, whether the card is safe to
format.

**Non-goals**: formatting or deleting anything on a card (formatting stays in
the camera, where it belongs); a second index — Winnow stays the only authority
on what the library holds; replacing the phone's own backup; touching any
original already on the NAS.

## 4. The shape: bytes over SMB, control over HTTP

The companion **copies over the SMB share the Mac already mounts**, and calls
Winnow's API only to ask and to tell. It does not upload through Winnow.

Why not through Winnow (`POST /api/upload` → inbox → import worker):

- the import worker files by `{device}/{date}` — the name dies (E21);
- `req.formData()` parses the whole multipart body before a byte is written
  (**to measure**, §13 — an SD card is 30–120 GB), and off the LAN the
  Cloudflare Tunnel caps a request body at 100 MB;
- the bytes would cross the network twice (Mac → Optiplex inbox → NFS to the
  Synology), on a box whose thermals are a design constraint
  (`docs/memory/pipeline.md`).

The optional Samba container that writes into the inbox has the same double
write and the same template.

What SMB costs: the companion must itself enforce what the import worker
enforces today — verify, deduplicate, never overwrite. §6 is that list. In
exchange it needs no new mount, no new service on the Optiplex, and nothing
exposed.

## 5. Knowing what is new: Winnow's own fingerprint

**Proposed**: the companion computes Winnow's `content_hash` on the card —
`partialHash` in `lib/hash.ts`: SHA-256 over the decimal size, the first 64 KiB
and the last 64 KiB — and asks Winnow which ones it already holds.

- It reads 128 KiB per file: ~200 MB for a 1 500-file card, seconds at SD speed.
- It asks the only authority, Postgres, so it covers what arrived by Finder, by
  FTP or through the web import, and it survives the loss of the Mac.
- It sees trashed and purged rows too, which is what `lib/import.ts` does
  today: a frame culled and purged is not re-imported by the next insertion of
  the same card. That holds only while a purged row keeps its hash — the purge
  worker does today, and MEMORY.md's open item on purge semantics would change
  it. **Fixing that item and building this lookup must be decided together**,
  or re-inserting an unformatted card resurrects every purged reject.

New endpoint `POST /api/ingest/lookup` `{ fingerprints: string[] }` (bounded,
e.g. 5 000) → for each known fingerprint `{ asset_id, zone, session, rel_path,
state: live | trashed | purged }`. Editor, like import. It is the query
`lib/import.ts` already runs, batched over the unique index.

**This turns the algorithm into a cross-repo contract.** `GET /api/capabilities`
gains an `ingest` block — `fingerprint: "psha256-64k-v1"`, the recognized
extensions, the sidecar rules, the ignored names — so the companion reads what
Winnow indexes instead of hardcoding it. Capabilities is already "add,
deprecate, never rename"; a change to `partialHash` or `classifyExt` becomes a
version bump rather than a silent drift.

**The partial hash decides "skip the copy", never "safe to format" on its own**
(§7). A false skip costs nothing while the card exists and everything once it
is formatted.

The Mac keeps a **ledger** (SQLite): the card (its volume UUID — exFAT's serial
changes on format, which is the behaviour wanted — plus the body's EXIF serial),
and per file its card path, size, mtime, fingerprint, full SHA-256 once copied,
state and destination. It is a cache (a re-inserted card costs nothing) and the
copy journal (§6.5), never the source of truth.

**Grouping into shoots.** New files are grouped per body by capture time, cut
at a silence — 2 h by default, the cut `docs/UNPLACED.md` §9 settled on — and
shown as cards: time span, counts per type, bytes, a strip of thumbnails. The
human merges or splits. Files already held are listed per destination ("1 180
already in `100MSDCF Tour Eiffel`"): that line is what retires the diff by eye.

**Card layouts are data, not code.** One profile per layout — a detection
signature, include/exclude globs, the sidecars to carry:

| layout | media | sidecars carried | excluded |
|---|---|---|---|
| Sony (`DCIM/NNNMSDCF`, `PRIVATE/M4ROOT`) | `DCIM/*/*.{ARW,HIF,JPG}`, `M4ROOT/CLIP/*.MP4` | `CLIP/*M01.XML` | `THMBNL/`, `SUB/`, `MEDIAPRO.XML`, `STATUS.BIN`, `PRIVATE/SONY/` |
| DJI (`DCIM/DJI_NNN`, older `DCIM/NNNMEDIA`) | `*.{DNG,JPG,MP4}` | `*.SRT` | `*.LRF`, anything outside `DCIM/` |

A shoot's stills and clips from one body land in the same folder — one body per
folder still holds — so Sony's `CLIP/` clips join the stills of their time
window.

## 6. Writing without collisions

The list the maintainer asked for; each rule names the failure it prevents.

1. **Nothing is visible before it is complete.** A job writes into
   `captures/.offload/<job-id>/<folder>/`. A dot-folder is skipped by the
   indexer, the import feeder and the folder picker alike (`isIgnoredEntry`,
   `lib/config.ts`), and the finished folder moves into place with one `rename`
   on the same share, atomic on the server. A scan running mid-job sees
   nothing; one running during the rename sees the folder or does not, never
   half of it. The dot rule thereby becomes a contract the companion depends on
   (§8).
2. **Never overwrite, anywhere.** macOS's smbfs is not trusted to refuse a
   rename onto an existing name, so the last step is check-then-rename under
   the single-writer rule (6.5), then a stat of the result.
3. **An existing destination folder is never merged into silently.** If the
   lookup shows the group already partly lives there (same shoot, continued),
   the job appends file by file, each file still staged then renamed.
   Otherwise the companion asks for another name. Two shoots, or two bodies, in
   one folder break the three things of §1.
4. **Same name, different bytes → suffix the whole capture, not the file.** In
   a folder, a name that exists with the same fingerprint is skipped; with a
   different one (a counter reset, two cards of one body), the capture takes
   `__N` — the convention `uniqueDest` already uses in `lib/import.ts` —
   applied to every file sharing its base: `DSC00123.ARW` + `.HIF` both become
   `DSC00123__1.*` (pairing is by base), `C0001.MP4` + `C0001M01.XML` become
   `C0001__1.MP4` + `C0001__1M01.XML` (the sidecar rule is base⇔base,
   `lib/sidecars.ts`).
5. **One writer, one journal, resumable.** One companion process copies one job
   at a time (the HDD, the thermals); a second card can be fingerprinted
   meanwhile. A lock file in `.offload/` names host, pid and start time, so a
   second instance — or a second Mac — refuses instead of interleaving. The
   staging folder *is* the journal: after a pulled card, a sleep or a dropped
   share, a restart keeps what the ledger marks verified, drops `.part` files
   and carries on. The Mac is held awake for the job (a power assertion).
6. **Verify against the NAS, not against the Mac's cache.** The source is
   hashed (full SHA-256) as it is read; the copy is re-read and hashed once
   written. Read back naïvely, the second read is served by the Mac's own
   buffer cache and proves nothing: it must bypass it (`F_NOCACHE`, **to
   confirm on smbfs**). What it then proves is that the Synology holds the right
   bytes, possibly still in its RAM; the disk surface is the NAS's job — Btrfs
   data checksums and scrubbing on the share (**to check** for volume 4).
7. **Space is checked before, not discovered during**: `statfs` on the mount
   against the job's bytes plus a margin — the preflight
   `ARCHITECTURE-REVIEW.md` §4 already lists as P1 for the pipeline.
8. **Winnow is told, not polled.** After the rename, `POST
   /api/ingest/delivered { folders }` enqueues the Incoming scan at high
   priority (`enqueueIndex` coalesces, so a repeated call is free) and writes
   an `import_batches` row, `origin = 'card_offload'`, with the job's report —
   the Import page's history then shows companion offloads beside web ones. It
   must stay a scan of the whole root, never of a subtree:
   `reconcileMissingForRoot` treats every row the walk did not visit as
   missing, so a partial walk would flag the rest of Incoming.

**And one guard on Winnow's side, for every writer the companion does not
control** (Finder, rsync, FTP): the indexer defers a new or changed file whose
mtime is younger than a quiet period (~2 min) — still recorded as seen, so
never "missing" — and enqueues a delayed scan whenever it deferred something.
That closes §2.1. One interaction to handle with it: `lib/import.ts` files with
`copyFile`, which on Linux does not carry the source's mtime, so its own freshly
filed files would be deferred once. Preserving the mtime there (`utimes`) is the
better fix regardless, since `captured_at` falls back to mtime for media without
a capture date.

## 7. "Safe to format", defined

A card is safe to format when **every media file its profile selects** is in
one of two states:

- **copied and verified by the companion** (6.6: full hash of the card file =
  full hash of the NAS copy, read past the cache) — this does not wait for
  Winnow to index it;
- **already held by Winnow** by fingerprint, in any state, with its path still
  present when the zone is Incoming — plus, optionally, a **full verify** that
  reads the card file and the NAS copy and compares full hashes, for when the
  partial hash should be out of the argument. Default: **open**. For a RAW, the
  first 64 KiB the partial hash covers include the EXIF header with the body's
  serial and the capture time.

Sidecars are covered by their clip. The notification says it in words: "A7C II
card — 1 243 files: 63 copied to `100MSDCF Tour Eiffel`, 1 180 already in the
library. Safe to format." The companion never formats and never deletes.

## 8. What Winnow has to provide

Small, in this repo, testable with `curl` and an app token before any companion
exists — one PR, no migration:

1. `POST /api/ingest/lookup` (§5) — editor.
2. `POST /api/ingest/delivered` (§6.8) — editor. The scan it enqueues is what
   the admin-only `/api/index` does, reached through an ingest verb the way
   `runImport` already reaches it.
3. `capabilities.ingest` (§5).
4. The quiet-period guard in `lib/indexer.ts`, and the mtime preserved in
   `lib/import.ts` (§6).

**Later, and the one that unlocks "name it afterwards"**:

5. **A safe rename/move inside Incoming.** `rename(2)` of the folder plus, in
   one transaction, every column that stores its path — `sessions.source_path`
   and `name`, `assets.abs_path`/`rel_path`, `asset_sidecars` — run as a job on
   the index queue so it cannot interleave with a scan. `lib/relink.ts` already
   moves rows onto new paths while keeping ids, ratings, pairs and derivatives;
   this is the same move made *before* the disk changes instead of repaired
   after. It also cures today's typo-in-a-folder-name deadlock, and it is what
   §10's FTP claim needs. Incoming only (finals are `:ro`); editor or admin —
   **open**.

Contracts that become cross-repo and deserve a comment where they live: the dot
rule of `isIgnoredEntry`, `partialHash`, the `__N` suffix, the sidecar base rule.

## 9. The companion: native, and why

**Recommendation: a SwiftUI menu-bar app in its own repository**, the app token
(editor) in the Keychain.

What only native gets:

- **DiskArbitration** — a callback on mount, and a mount-approval hook that
  re-mounts a camera card **read-only**: nothing can write on it, not the
  companion, not Spotlight, not a stray Finder rename (§2.4);
- **QuickLook / ImageIO thumbnails of ARW, HIF and MP4** on the naming sheet,
  at the moment currently spent in Finder — naming a shoot needs to see it;
- `F_NOCACHE` reads, a power assertion, notifications, progress in the menu bar;
- **ImageCaptureCore and PhotoKit** for the phone later (§10), which have no
  scriptable equivalent short of `osxphotos`.

Rejected:

- **Rust** — every piece of value above is an Apple framework, reached from Rust
  through FFI, and a UI toolkit would still be missing (Tauri means a web UI,
  which is what Winnow already is). It pays only if the companion had to run
  somewhere other than this Mac.
- **Automator, Shortcuts, a Folder Action on `/Volumes`** — a trigger, not a
  program: the verify / journal / resume logic of §6 does not belong in
  AppleScript.
- **A shell script around `rsync`** — an honest stopgap, not the answer. rsync
  writes into hidden temp names (Winnow-safe by accident) and resumes, and
  launchd's `StartOnMount` can start it; but it deduplicates by path, not
  content, cannot ask Winnow anything, cannot name, and its `--checksum`
  re-read hits the cache of 6.6. It is §11's step 0 if something is wanted this
  week.
- **A Node CLI importing `lib/hash.ts`** — tempting for "one implementation",
  but it would drag `lib/config.ts` (the server's whole env schema) onto the
  Mac, the naming UI would still be missing, and §5's contract removes the
  reason: the rules come from `capabilities`, and the fingerprint is twenty
  lines to re-implement against a version string.

The cost, said plainly: a second stack (Swift) in a TypeScript portfolio, and a
second repository to keep in step. The mitigation is to keep the companion dumb
— detect, fingerprint, ask, copy, verify, tell — and to keep every rule about
*what Winnow indexes* on Winnow's side.

## 10. FTP, the phone, and the web import

**FTP (Sony A7C II)**: the camera needs a network that *reaches the FTP
server*, not the Internet. At home it can join the house Wi-Fi and push to the
optional `ftp` service in `docker-compose.yml`, which writes into the inbox. In
the field a phone hotspot gives it a network but no route home: the Cloudflare
Tunnel carries HTTP, not FTP, and exposing FTP on the router is what
`docs/memory/deployment.md` rules out. So FTP is a home feeder at best — and it
**collides with the card path**. Whatever arrives first wins the dedup: frames
sent by FTP are filed under `{device}/{date}` (E21), the card offload of the
same shoot then finds them already held, and the named folder comes out with
holes. If only HIF/JPEG went by FTP, every RAW+HIF pair ends up split across
two folders, and pairing is per folder. The same holds for the Creators' App
auto-transfer to the phone. **Open**: one path per shoot, or the companion
*claims* the early copies into the named folder through §8.5's move.

**iPhone + Ray-Ban Meta**: one source, the phone's library — and not a
session-shaped one. The phone shoots continuously, which is exactly the case
the `{device}/{YYYY}/{date}` template fits. Keep the web upload for the phone;
later, the companion can export originals (Live Photo pairs included) from the
Mac's Photos library through PhotoKit, from the last export onwards —
`osxphotos export --update` is the script-grade version of the same idea.

**The web import** is the next conversation. What carries over from here: the
named-folder model (a session-name field would retire E21 for anyone with a
folder convention), the lookup, the quiet guard. What does not: the transport,
for §4's reasons.

## 11. Order of work

0. **Now, no code**: keep naming before copying; never rename a folder in
   `captures` that Winnow has seen (if it happens: *Failures › Missing files ›
   Moved, not deleted*); do not copy `PRIVATE/M4ROOT` whole. If a stopgap is
   wanted: `rsync` into a dot-folder of `captures`, then one `mv` into place.
1. **Winnow contract** (§8.1–8.4): one PR, no migration.
2. **Companion v1**: the Sony and DJI profiles, read-only mount, lookup,
   grouping, naming sheet, staged copy, verify, deliver, safe-to-format
   notification.
3. **Safe rename/move in Winnow** (§8.5): naming afterwards from the web UI,
   typo fixes, the FTP claim.
4. **The phone**: a PhotoKit export in the companion, if the web upload is not
   enough.

## 12. Open questions, in blocking order

1. Where does today's renaming happen — on the card, or on the Mac? (§2.4)
2. Name before the copy only, or also "land under a default, rename in Winnow
   later" — which puts §8.5 before the companion?
3. The folder name: keep `{card folder} {name}` exactly, or add the date
   (`100MSDCF 2026-09-27 Tour Eiffel`)? The card-folder prefix is what keeps
   bodies apart and stays either way.
4. "Safe to format": trust the partial hash for already-held files, or
   full-verify by default? (§7)
5. FTP: one path per shoot, or claim? (§10)
6. Swift in its own repository — acceptable as a second stack? (§9)

## 13. Measure before promising

- SMB throughput Mac → Synology over the cable and over Wi-Fi, with and without
  SMB signing: the companion's ETA and the §2.1 window both depend on it.
- Whether `req.formData()` in `/api/upload` buffers the body — it bounds the web
  import too.
- Whether smbfs honours `F_NOCACHE` (6.6), and whether the `Computing` share
  has Btrfs data checksums.
- The cost of one lookup of 5 000 fingerprints (it should be one index probe
  each).
