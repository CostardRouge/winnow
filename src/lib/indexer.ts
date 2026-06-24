// Indexer — incremental scan of a NAS root (cf. §3).
// Reads each file ONCE ONLY: metadata + partial hash.
// Enqueues derivatives for every recognized asset (photo → sharp, video →
// ffmpeg poster + mp4 proxy) that lives outside an ignored session.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { q, one } from "./db";
import { classifyExt, config } from "./config";
import { partialHash, sameContent } from "./hash";
import { readMetadata } from "./extract";
import { enqueueDerivative, PRIORITY } from "./queue";
import { recordScanFailure } from "./failures";
import { recordDuplicateHit } from "./duplicates";
import {
  reconcileGroupsForSession,
  reconcileLivePhotosForSession,
} from "./pairing";
import { reconcileBurstsForSession } from "./bursts";
import { recordSidecars } from "./sidecars";
import type { Root, Session } from "./types";

// Optional hooks injected by the worker: allow suspending/preempting
// the scan (shouldStop) and smoothing its rate (throttle, called before each
// heavy file read). In CLI/sync, no hooks → nominal behavior.
export type IndexHooks = {
  shouldStop?: () => Promise<boolean> | boolean;
  throttle?: () => Promise<void>;
};

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Unable to read ${dir}:`, (err as Error).message);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .DS_Store, hidden folders
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function ensureSession(
  root: Root,
  dir: string,
): Promise<Session> {
  const existing = await one<Session>(
    "SELECT * FROM sessions WHERE source_path = $1",
    [dir],
  );
  if (existing) return existing;
  const name = path.relative(root.path, dir) || path.basename(dir) || root.path;
  const row = await one<Session>(
    `INSERT INTO sessions (root_id, name, source_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_path) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [root.id, name, dir],
  );
  return row!;
}

export type IndexResult = {
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  duplicates: number;
  // False partial-hash collisions: distinct files recovered and indexed instead
  // of being silently dropped (review §4). Subset of `inserted`.
  recovered: number;
  enqueued: number;
  failed: number;
  // RAW+JPEG pairs newly tied together this scan (cf. lib/pairing.ts).
  paired: number;
  // Burst/bracket stacks newly clustered this scan (cf. lib/bursts.ts).
  stacked: number;
  // Video sidecars (Sony .XML / .THM) tied to their clip this scan (lib/sidecars.ts).
  sidecars: number;
  // true if the scan was interrupted (pause or preemption) before the end.
  stopped: boolean;
};

export async function indexRoot(
  rootId: number,
  hooks: IndexHooks = {},
): Promise<IndexResult> {
  const root = await one<Root>("SELECT * FROM roots WHERE id = $1", [rootId]);
  if (!root) throw new Error(`Root not found: ${rootId}`);

  // Derivatives of incoming media go ahead of those of other roots.
  const derivePriority =
    root.path === config.import.incomingDir ? PRIORITY.high : PRIORITY.normal;

  const res: IndexResult = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    duplicates: 0,
    recovered: 0,
    enqueued: 0,
    failed: 0,
    paired: 0,
    stacked: 0,
    sidecars: 0,
    stopped: false,
  };
  const touchedSessions = new Set<number>();
  // Memoize per-directory file listings so a clip-heavy session reads each
  // folder at most once while detecting video sidecars.
  const dirCache = new Map<string, string[]>();

  for await (const absPath of walk(root.path)) {
    // Suspension/preemption: we stop cleanly between two files.
    // Since indexing is incremental, a resume will restart without reprocessing
    // files already known.
    if (hooks.shouldStop && (await hooks.shouldStop())) {
      res.stopped = true;
      break;
    }

    const ext = path.extname(absPath);
    const cls = classifyExt(ext);
    if (!cls) continue; // not a recognized media
    res.scanned++;

    // Per-file isolation: an unreadable/corrupt file (stat, hash, metadata)
    // must not fail the entire indexing job.
    try {
    const st = await stat(absPath);
    const size = st.size;
    const mtime = st.mtime.toISOString();
    const dir = path.dirname(absPath);

    const session = await ensureSession(root, dir);
    touchedSessions.add(session.id);

    const existing = await one<{
      id: number;
      file_size: string | number | null;
      file_mtime: string | null;
    }>("SELECT id, file_size, file_mtime FROM assets WHERE abs_path = $1", [
      absPath,
    ]);

    // Incremental scan: unchanged (size + mtime) → we skip.
    if (
      existing &&
      Number(existing.file_size) === size &&
      existing.file_mtime &&
      new Date(existing.file_mtime).getTime() === st.mtime.getTime()
    ) {
      res.skipped++;
      continue;
    }

    // Smoothing the scan rate: we throttle only the *heavy* reads
    // (new/modified file), not unchanged files that are merely stat-ed.
    if (hooks.throttle) await hooks.throttle();

    const hash = await partialHash(absPath, size);
    const meta = await readMetadata(absPath);
    const capturedAt = meta.captured_at ?? mtime; // always populated → useful index
    const ignored = session.ignored;

    if (existing) {
      // Modified file: we update and re-enqueue the derivative (photo or
      // video) unless the session is ignored.
      const willDerive = !ignored;
      await q(
        `UPDATE assets SET
           rel_path=$2, filename=$3, ext=$4, media_type=$5, device=$6,
           file_size=$7, file_mtime=$8, content_hash=$9, captured_at=$10,
           camera_model=$11, lens=$12, iso=$13, shutter=$14, aperture=$15,
           focal_length=$16, gps=$17, width=$18, height=$19, duration_s=$20,
           content_id=$23,
           derivative_status=$21,
           processing_state=CASE WHEN $22 THEN 'ignored' ELSE processing_state END,
           updated_at=now()
         WHERE id=$1`,
        [
          existing.id,
          path.relative(root.path, absPath),
          path.basename(absPath),
          ext.toLowerCase(),
          cls.mediaType,
          meta.device,
          size,
          mtime,
          hash,
          capturedAt,
          meta.camera_model,
          meta.lens,
          meta.iso,
          meta.shutter,
          meta.aperture,
          meta.focal_length,
          meta.gps ? JSON.stringify(meta.gps) : null,
          meta.width,
          meta.height,
          meta.duration_s,
          willDerive ? "pending" : "skipped",
          ignored,
          meta.content_id,
        ],
      );
      res.updated++;
      if (willDerive) {
        await enqueueDerivative(existing.id, { priority: derivePriority });
        res.enqueued++;
      }
      if (cls.mediaType === "video") {
        res.sidecars += await recordSidecars({
          assetId: existing.id,
          absPath,
          rootPath: root.path,
          dirCache,
        });
      }
      continue;
    }

    // New file. A non-null content_hash is subject to the unique index, so an
    // ON CONFLICT means another path already holds this *partial* hash.
    // Derivatives are generated for both photos and videos (the worker picks
    // the right pipeline from media_type); only ignored sessions are skipped.
    const willDerive = !ignored;
    const insertAsset = (hashValue: string | null) =>
      one<{ id: number }>(
        `INSERT INTO assets (
           session_id, abs_path, rel_path, filename, ext, media_type, device,
           file_size, file_mtime, content_hash, captured_at, camera_model, lens,
           iso, shutter, aperture, focal_length, gps, width, height, duration_s,
           derivative_status, processing_state, content_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
           $20,$21,$22,$23,$24
         )
         ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          session.id,
          absPath,
          path.relative(root.path, absPath),
          path.basename(absPath),
          ext.toLowerCase(),
          cls.mediaType,
          meta.device,
          size,
          mtime,
          hashValue,
          capturedAt,
          meta.camera_model,
          meta.lens,
          meta.iso,
          meta.shutter,
          meta.aperture,
          meta.focal_length,
          meta.gps ? JSON.stringify(meta.gps) : null,
          meta.width,
          meta.height,
          meta.duration_s,
          willDerive ? "pending" : "skipped",
          ignored ? "ignored" : "unprocessed",
          meta.content_id,
        ],
      );

    let inserted = await insertAsset(hash);

    if (!inserted) {
      // Partial-hash collision. Before silently dropping the file — which for a
      // photo archive could mean losing a genuine, distinct shot — confirm the
      // collision by comparing the FULL content against the asset that holds
      // the hash (cf. review §4; partial hash = size + endpoints, see hash.ts).
      const match = await one<{ id: number; abs_path: string }>(
        "SELECT id, abs_path FROM assets WHERE content_hash = $1",
        [hash],
      );
      const same = match ? await sameContent(absPath, match.abs_path) : null;
      if (same === false) {
        // FALSE collision: the two files genuinely differ. Index this one with a
        // NULL content_hash so it escapes the unique index and is never lost.
        inserted = await insertAsset(null);
        if (inserted) res.recovered++;
      }
      await recordDuplicateHit({
        absPath,
        contentHash: hash,
        existingAssetId: match?.id ?? null,
        source: "index",
        verified: same,
        fileSize: size,
      });
      if (!inserted) {
        res.duplicates++; // confirmed (or unverifiable) duplicate: not reprocessed
        continue;
      }
    }

    await q(
      "INSERT INTO ratings (asset_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [inserted.id],
    );
    res.inserted++;
    if (willDerive) {
      await enqueueDerivative(inserted.id, { priority: derivePriority });
      res.enqueued++;
    }
    if (cls.mediaType === "video") {
      res.sidecars += await recordSidecars({
        assetId: inserted.id,
        absPath,
        rootPath: root.path,
        dirCache,
      });
    }
    } catch (err) {
      res.failed++;
      const msg = (err as Error).message;
      console.warn(`Unable to index ${absPath}:`, msg);
      // Persist the failure so it can be listed/retried from the UI.
      await recordScanFailure(absPath, root.id, msg);
    }
  }

  // Recompute counters/capture ranges per touched session.
  for (const sid of touchedSessions) {
    await q(
      `UPDATE sessions s SET
         asset_count = sub.cnt,
         captured_at_min = sub.cmin,
         captured_at_max = sub.cmax,
         device_hint = sub.device,
         indexed_at = now()
       FROM (
         SELECT
           count(*) AS cnt,
           min(captured_at) AS cmin,
           max(captured_at) AS cmax,
           mode() WITHIN GROUP (ORDER BY device) AS device
         FROM assets WHERE session_id = $1
       ) sub
       WHERE s.id = $1`,
      [sid],
    );
    // Tie freshly indexed siblings into logical pairs. Runs after the counters
    // above so newly inserted/updated files are visible to the matcher. RAW+JPEG
    // first (shared basename), then iPhone Live Photos (still + .mov sharing the
    // Apple Content Identifier). Both skip already-grouped files, so the order
    // only decides which claims an asset eligible for both (a non-issue in
    // practice: a RAW shares no content_id with a .mov).
    res.paired += await reconcileGroupsForSession(sid);
    res.paired += await reconcileLivePhotosForSession(sid);
    // Then cluster bursts/brackets over the now-paired logical media: a stack is
    // built from displayed primaries (companions skipped), so it composes with —
    // rather than collides with — pairing (cf. lib/bursts.ts).
    res.stacked += await reconcileBurstsForSession(sid);
  }

  return res;
}
