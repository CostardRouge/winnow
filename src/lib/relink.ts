// Relink moved originals — the repair for a folder reorganisation.
//
// Asset identity is `abs_path` (UNIQUE), so the pipeline has no notion of a
// move: reorganising files inside a root makes each file look like TWO
// unrelated events that lock each other (cf. docs/memory/pipeline.md).
//
//   - at its new path the file is "new": its INSERT hits the content_hash
//     unique index, and the collision-recovery branch calls sameContent()
//     against the OLD path — now ENOENT — which answers `null`, not `false`.
//     Only `false` triggers the recovery insert, so the file is counted as an
//     unverifiable duplicate and NEVER indexed;
//   - end-of-scan reconciliation does not see the old path, confirms ENOENT,
//     and flags the row missing + auto-trashes it (lib/integrity.ts).
//
// That state is stable: every rescan repeats it verbatim, so no amount of
// scanning repairs it. This module closes the loop by matching the orphaned
// rows to the files that are still on disk, and moving each row onto its file.
//
// WHY RELINK RATHER THAN REINDEX. Derivative objects are keyed by asset id
// (`thumb/${id}.webp`), so a relink keeps the id and everything hanging off it:
// rating/verdict, tags, pairing (group_id), burst membership, the finals→source
// edit link, geocoding and the whole EXIF row. A reindex would need the hash
// released first and would still lose all of that. `mv` also preserves mtime,
// so a relinked file goes straight back through the indexer's size+mtime gate:
// no re-hash, no exiftool.
//
// PURGED ROWS ARE RECOVERABLE TOO, and this is the case that matters most,
// because purging is the natural (and wrong) reflex when hundreds of files show
// up as missing. The purge worker does NOT release `content_hash` — only
// reclaimTrashedAsset() in lib/duplicates.ts does — so a purged row keeps
// squatting the unique hash and the moved file stays unindexable *forever*.
// What a purge actually destroyed is narrow and rebuildable: the thumb/proxy
// objects, the asset_faces / asset_clip rows, and the asset_sidecars rows.
// Ratings are kept by design, and so is every column on the asset row. This
// module therefore un-stamps the purge, re-enqueues the derivative (which
// re-enqueues ML on completion, cf. lib/derivatives.ts) and re-records the
// sidecars — the repair costs one derivative + one ML pass per asset.
//
// SAFETY — this moves rows onto files, so every match is proven, never guessed:
//   - the candidate file must be unindexed (abs_path is UNIQUE) and its size
//     must equal the orphan's, which is also the prefilter that keeps the walk
//     cheap: only size-matching unindexed files are ever hashed;
//   - its partial hash must equal the orphan's content_hash (same key the
//     indexer dedups on, cf. lib/hash.ts);
//   - the orphan's OLD path must answer ENOENT. That is what distinguishes a
//     MOVE from a COPY: if the old file is still there, the new one is a
//     genuine duplicate and is left alone;
//   - one orphan matching several files on disk is AMBIGUOUS and skipped
//     entirely — never resolved by picking one (same rule as lib/reconcile.ts);
//   - a file found under a different root than its orphan's is reported, not
//     relinked: moving an asset between volumes changes its role
//     (source/finals/export) and is a decision, not a repair.
//
// Dry-run is the default everywhere: nothing is written unless `apply` is set.
import { stat } from "node:fs/promises";
import path from "node:path";
import { q, one, many } from "./db";
import { classifyExt, config } from "./config";
import { partialHash } from "./hash";
import { walk, ensureSession } from "./indexer";
import { enqueueDerivative, PRIORITY } from "./queue";
import { recordSidecars } from "./sidecars";
import {
  reconcileGroupsForSession,
  reconcileLivePhotosForSession,
} from "./pairing";
import { reconcileBurstsForSession } from "./bursts";
import { isWalkable } from "./volumes";
import type { Root } from "./types";

// State an orphaned row was left in, purely for reporting — the repair is the
// same in all three cases, but "purged" is the one that also costs a rebuild.
export type OrphanState = "purged" | "trashed" | "flagged";

export type RelinkMatch = {
  assetId: number;
  filename: string;
  oldPath: string;
  newPath: string;
  state: OrphanState;
  fileSize: number | null;
  // True when the row lost its derivatives (purged): it needs a rebuild, and
  // with it a fresh ML pass.
  needsRebuild: boolean;
};

export type RelinkSkip = { path: string; reason: string };

export type RelinkReport = {
  // False for a dry run: matches are reported, nothing is written.
  applied: boolean;
  // Orphans in scope (missing_at set, still holding a content_hash).
  orphans: number;
  // Media files the walk saw / that no asset row claims.
  scanned: number;
  unindexed: number;
  // Unindexed files whose size matched an orphan, so they were hashed.
  hashed: number;
  matches: RelinkMatch[];
  relinked: number;
  // Orphans matching several files on disk: never resolved automatically.
  ambiguous: number;
  skipped: RelinkSkip[];
  derivativesQueued: number;
  sidecarsRecorded: number;
};

type Orphan = {
  id: number;
  abs_path: string;
  content_hash: string;
  file_size: string | number | null;
  media_type: string;
  session_id: number;
  root_id: number;
  thumb_key: string | null;
  purged: boolean;
  trashed: boolean;
};

function orphanState(o: Orphan): OrphanState {
  if (o.purged) return "purged";
  return o.trashed ? "trashed" : "flagged";
}

// Every asset whose file we could not find but whose content we can still
// recognise. Purged rows are INCLUDED on purpose: they are the ones still
// holding the content_hash hostage, and they are exactly as recoverable.
// A NULL content_hash (a recovered false collision) can never be matched, so
// those rows are out of scope.
async function loadOrphans(): Promise<Orphan[]> {
  return many<Orphan>(
    `SELECT a.id, a.abs_path, a.content_hash, a.file_size, a.media_type,
            a.session_id, s.root_id, a.thumb_key,
            (a.purged_at IS NOT NULL)  AS purged,
            (a.deleted_at IS NOT NULL) AS trashed
       FROM assets a
       JOIN sessions s ON s.id = a.session_id
      WHERE a.missing_at IS NOT NULL
        AND a.content_hash IS NOT NULL`,
  );
}

// ENOENT — and only ENOENT — proves the old file is gone. An unreachable mount
// or a permission error says nothing, and must never be read as a move.
async function isGone(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

// Walks `root` and pairs each orphan with the file that now holds its content.
// Read-only: it stats, hashes and queries, but writes nothing.
async function findMoved(
  root: Root,
  orphans: Orphan[],
  report: RelinkReport,
): Promise<Map<number, { orphan: Orphan; paths: string[] }>> {
  // Size is the prefilter that keeps this affordable on an 80k library: a file
  // whose size matches no orphan cannot be one, and is never opened.
  const bySize = new Map<number, Orphan[]>();
  for (const o of orphans) {
    const size = Number(o.file_size ?? -1);
    if (size < 0) continue;
    const list = bySize.get(size);
    if (list) list.push(o);
    else bySize.set(size, [o]);
  }
  const byHash = new Map<string, Orphan>();
  for (const o of orphans) byHash.set(o.content_hash, o);

  // One stat per orphan at most, whatever how many candidates point at it.
  const goneCache = new Map<number, boolean>();
  const hits = new Map<number, { orphan: Orphan; paths: string[] }>();

  for await (const absPath of walk(root.path)) {
    if (!classifyExt(path.extname(absPath))) continue;
    report.scanned++;

    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      continue; // vanished mid-walk, or unreadable: not our business here
    }
    if (!bySize.has(size)) continue;

    // Only now is a DB round-trip worth it. abs_path is UNIQUE across every
    // state, so a row here means the path is spoken for — live, trashed or
    // purged — and is not a landing spot for a relink.
    const taken = await one<{ id: number }>(
      "SELECT id FROM assets WHERE abs_path = $1",
      [absPath],
    );
    if (taken) continue;
    report.unindexed++;

    report.hashed++;
    let hash: string;
    try {
      hash = await partialHash(absPath, size);
    } catch (err) {
      report.skipped.push({
        path: absPath,
        reason: `unreadable: ${(err as Error).message}`,
      });
      continue;
    }

    const orphan = byHash.get(hash);
    if (!orphan) continue;

    // A move, or a copy? If the orphan's old file is still on disk, this is a
    // second copy of a file we simply failed to stat earlier — leave it to the
    // ordinary dedup path rather than moving the row onto it.
    let gone = goneCache.get(orphan.id);
    if (gone === undefined) {
      gone = await isGone(orphan.abs_path);
      goneCache.set(orphan.id, gone);
    }
    if (!gone) {
      report.skipped.push({
        path: absPath,
        reason: `the original is still at ${orphan.abs_path} — this is a copy, not a move`,
      });
      continue;
    }

    // Crossing volumes changes what the asset IS (cullable source vs view-only
    // final), so it is reported and left to the user.
    if (orphan.root_id !== root.id) {
      report.skipped.push({
        path: absPath,
        reason: `asset ${orphan.id} belongs to root ${orphan.root_id}; relinking across volumes changes its role — move it deliberately`,
      });
      continue;
    }

    const hit = hits.get(orphan.id);
    if (hit) hit.paths.push(absPath);
    else hits.set(orphan.id, { orphan, paths: [absPath] });
  }

  return hits;
}

// Moves one row onto its file. Ordered so a failure can never leave the asset
// live at a path we have not verified: the UPDATE is the commit point, and
// everything after it is repair work that is safe to redo on a re-run.
async function applyOne(
  root: Root,
  match: RelinkMatch,
  orphan: Orphan,
  report: RelinkReport,
  touched: Set<number>,
  dirCache: Map<string, string[]>,
): Promise<void> {
  const dir = path.dirname(match.newPath);
  const session = await ensureSession(root, dir);

  // `deleted_at = missing_at` is the marker integrity.ts sets when the auto-
  // trash is OURS (one statement, one timestamp). A user's own soft-delete
  // carries a different timestamp and is respected here exactly as
  // restoreMissing() does — they culled that media; finding its file again is
  // not a reason to put it back in the library.
  //
  // Postgres evaluates every SET expression against the OLD tuple, so clearing
  // missing_at in the same statement does not disturb the comparison.
  const updated = await one<{ id: number }>(
    `UPDATE assets
        SET abs_path = $2,
            rel_path = $3,
            session_id = $4,
            file_mtime = $5,
            missing_at = NULL,
            deleted_at = CASE WHEN deleted_at = missing_at THEN NULL ELSE deleted_at END,
            purged_at = NULL,
            purge_error = NULL,
            derivative_status = CASE WHEN thumb_key IS NULL THEN 'pending'
                                     ELSE derivative_status END,
            updated_at = now()
      WHERE id = $1 AND missing_at IS NOT NULL
      RETURNING id`,
    [
      orphan.id,
      match.newPath,
      path.relative(root.path, match.newPath),
      session.id,
      (await stat(match.newPath)).mtime.toISOString(),
    ],
  );
  if (!updated) {
    // Restored or repaired by something else between the scan and now.
    report.skipped.push({
      path: match.newPath,
      reason: `asset ${orphan.id} is no longer flagged missing — skipped`,
    });
    return;
  }
  report.relinked++;
  touched.add(session.id);
  touched.add(orphan.session_id);

  // A purge cleared the derivative objects; rebuilding one also re-enqueues the
  // ML pass that restores the faces/CLIP rows it reaped (cf. lib/derivatives).
  if (match.needsRebuild) {
    await enqueueDerivative(orphan.id, {
      priority:
        root.path === config.import.incomingDir ? PRIORITY.high : PRIORITY.normal,
    });
    report.derivativesQueued++;
  }

  // A purge also deleted the clip's sidecar ROWS while its unlink of their old
  // paths silently no-op'd on ENOENT — the .XML/.THM files travelled with the
  // clip and are still there, so re-record them from the new folder.
  if (orphan.media_type === "video") {
    const sc = await recordSidecars({
      assetId: orphan.id,
      absPath: match.newPath,
      rootPath: root.path,
      dirCache,
    });
    report.sidecarsRecorded += sc.recorded;
  }

  // The audit row that recorded this file as a duplicate described the
  // deadlock, not a duplicate: it is resolved now.
  await q("DELETE FROM duplicate_hits WHERE abs_path = $1", [match.newPath]);
}

// Recompute what a scan would have recomputed for the folders we touched:
// counters/date ranges, then pairing and burst clustering (both idempotent and
// scoped to still-ungrouped assets, so a relinked row keeps the group it had).
async function refreshSessions(sessionIds: Iterable<number>): Promise<void> {
  for (const sid of sessionIds) {
    await q(
      `UPDATE sessions s SET
         asset_count = sub.cnt,
         captured_at_min = sub.cmin,
         captured_at_max = sub.cmax,
         device_hint = sub.device,
         indexed_at = now()
       FROM (
         SELECT count(*) AS cnt,
                min(captured_at) AS cmin,
                max(captured_at) AS cmax,
                mode() WITHIN GROUP (ORDER BY device) AS device
           FROM assets WHERE session_id = $1
       ) sub
       WHERE s.id = $1`,
      [sid],
    );
    await reconcileGroupsForSession(sid);
    await reconcileLivePhotosForSession(sid);
    await reconcileBurstsForSession(sid);
  }
}

// Repair one root. `apply` defaults to false: the caller sees the full match
// list before anything is written.
export async function relinkMovedForRoot(
  root: Root,
  opts: { apply?: boolean } = {},
): Promise<RelinkReport> {
  const apply = opts.apply === true;
  const report: RelinkReport = {
    applied: apply,
    orphans: 0,
    scanned: 0,
    unindexed: 0,
    hashed: 0,
    matches: [],
    relinked: 0,
    ambiguous: 0,
    skipped: [],
    derivativesQueued: 0,
    sidecarsRecorded: 0,
  };

  // Same guard as every integrity pass: an unreachable root proves nothing
  // about its files, and walking it would read every asset as moved.
  if (await isGone(root.path)) {
    report.skipped.push({
      path: root.path,
      reason: "root unreachable — pass skipped",
    });
    return report;
  }

  const orphans = await loadOrphans();
  report.orphans = orphans.length;
  if (!orphans.length) return report;

  const hits = await findMoved(root, orphans, report);

  const touched = new Set<number>();
  const dirCache = new Map<string, string[]>();

  for (const { orphan, paths } of hits.values()) {
    if (paths.length > 1) {
      report.ambiguous++;
      report.skipped.push({
        path: orphan.abs_path,
        reason: `asset ${orphan.id} matches ${paths.length} files on disk (${paths.join(", ")}) — ambiguous, left untouched`,
      });
      continue;
    }
    const match: RelinkMatch = {
      assetId: orphan.id,
      filename: path.basename(paths[0]),
      oldPath: orphan.abs_path,
      newPath: paths[0],
      state: orphanState(orphan),
      fileSize: orphan.file_size == null ? null : Number(orphan.file_size),
      needsRebuild: orphan.thumb_key == null,
    };
    report.matches.push(match);
    if (apply) await applyOne(root, match, orphan, report, touched, dirCache);
  }

  if (apply && touched.size) await refreshSessions(touched);
  return report;
}

// Repair every walkable root (or just one). Roots are processed in order so the
// orphan set is re-read per root and a file relinked by an earlier root is not
// offered again by a later one.
export async function relinkMoved(
  opts: { rootId?: number; apply?: boolean } = {},
): Promise<{ perRoot: { root: Root; report: RelinkReport }[] }> {
  const roots = opts.rootId
    ? await many<Root>("SELECT * FROM roots WHERE id = $1", [opts.rootId])
    : await many<Root>("SELECT * FROM roots ORDER BY id");

  const perRoot: { root: Root; report: RelinkReport }[] = [];
  for (const root of roots) {
    if (!isWalkable(root.kind)) continue;
    perRoot.push({ root, report: await relinkMovedForRoot(root, opts) });
  }
  return { perRoot };
}
