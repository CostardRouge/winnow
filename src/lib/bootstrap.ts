// Idempotent registration of known roots, run at worker startup.
//  - the incoming (kind='source'): guarantees indexing even without a recent import;
//  - each configured final folder (kind='finals'): indexed for viewing
//    (thumbnails), never culled — read-only is enforced on the UI side.
// Without this bootstrap, a final folder would stay empty: previously the
// 'finals' roots were never indexed.
import { stat } from "node:fs/promises";
import { q, many } from "./db";
import { config } from "./config";
import { coalescePendingIndexJobs, enqueueDerivative, enqueueIndex } from "./queue";
import { dedupeOverlappingRoots, isWalkable } from "./volumes";
import type { Root } from "./types";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Register a directory as a root (idempotent). Enqueuing the scan is deferred
// to the caller so overlapping roots can be deduped across the whole set first.
async function ensureRoot(path: string, kind: Root["kind"]): Promise<void> {
  await q(
    `INSERT INTO roots (path, kind, watch) VALUES ($1, $2, true)
     ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind`,
    [path, kind],
  );
}

export async function bootstrapRoots(): Promise<void> {
  // Self-heal: drop any duplicate scans left over from before coalescing existed
  // (or queued while a worker was down) so each root starts with one pending job.
  try {
    const dropped = await coalescePendingIndexJobs();
    if (dropped > 0) console.log(`[bootstrap] coalesced ${dropped} duplicate scan job(s)`);
  } catch (err) {
    console.error("[bootstrap] scan-queue coalescing failed:", err);
  }

  const { incomingDir, finalsDirs } = config.import;
  const dirs: Array<{ path: string; kind: Root["kind"] }> = [];
  if (incomingDir) dirs.push({ path: incomingDir, kind: "source" });
  for (const d of finalsDirs) dirs.push({ path: d, kind: "finals" });
  // The export folder is surfaced as a volume too (visibility), not indexed.
  if (config.exportDir) dirs.push({ path: config.exportDir, kind: "export" });

  for (const { path, kind } of dirs) {
    if (!(await exists(path))) {
      console.warn(`[bootstrap] ${kind} not found, ignored: ${path}`);
      continue;
    }
    try {
      await ensureRoot(path, kind);
      console.log(`[bootstrap] ${kind} registered: ${path}`);
    } catch (err) {
      console.error(`[bootstrap] failure ${path}:`, err);
    }
  }

  // Enqueue an initial scan of every watched, walkable root — but only the
  // non-overlapping set. A finals folder nested inside the incoming tree (both
  // seeded from the env) would otherwise be walked twice, double-indexing every
  // shared file. Keep the container, skip the nested one, and say so.
  try {
    const watched = await many<{ id: number; path: string; kind: Root["kind"] }>(
      "SELECT id, path, kind FROM roots WHERE watch = true",
    );
    const walkable = watched.filter((r) => isWalkable(r.kind));
    const { kept, dropped } = dedupeOverlappingRoots(walkable);
    for (const d of dropped)
      console.warn(
        `[bootstrap] "${d.root.path}" overlaps "${d.coveredBy.path}" — not indexed (already covered); remove the nested volume`,
      );
    for (const r of kept) await enqueueIndex(r.id);
  } catch (err) {
    console.error("[bootstrap] initial scan enqueue failed:", err);
  }

  await recoverStuckProcessing();
  await backfillVideoDerivatives();
}

// Self-heal: derivative jobs that were interrupted mid-flight leave their asset
// stranded at derivative_status='processing'. The flag is written to Postgres at
// the very start of generateDerivative and only cleared when the job reaches
// 'ready'/'error', so a worker killed or restarted in between (a compose
// restart, an OOM, dev hot-reload) leaves an orphan: incremental indexing never
// revisits an unchanged file, and nothing else re-enqueues a 'processing' row,
// so it would sit there forever. On a fresh worker no derivative job is running
// yet, so every 'processing' row is necessarily a leftover — we reset it to
// 'pending' and re-enqueue. Idempotent (a clean start matches nothing) and safe
// even if a duplicate job lingered: generateDerivative re-reads the status and
// is a no-op on a skipped/deleted asset. (Assumes the single worker the deploy
// runs; with multiple replicas this could re-enqueue another's in-flight item,
// which is merely wasted, idempotent work.)
async function recoverStuckProcessing(): Promise<void> {
  try {
    const stuck = await many<{ id: number }>(
      `UPDATE assets
         SET derivative_status = 'pending', updated_at = now()
       WHERE derivative_status = 'processing'
         AND processing_state <> 'ignored'
         AND deleted_at IS NULL
       RETURNING id`,
    );
    if (stuck.length === 0) return;
    for (const a of stuck) await enqueueDerivative(a.id);
    console.log(
      `[bootstrap] re-enqueued ${stuck.length} stuck 'processing' derivative(s)`,
    );
  } catch (err) {
    console.error("[bootstrap] stuck-processing recovery failed:", err);
  }
}

// Retroactive fix: videos used to be indexed with derivative_status='skipped'
// (only photos were enqueued), so the ffmpeg poster/proxy was never built. The
// incremental scan never revisits them (unchanged mtime+size), so we re-enqueue
// the orphans once here. Idempotent: after this pass they leave 'skipped', so a
// later startup matches nothing. Ignored sessions and soft-deleted assets stay
// untouched (a derivative there would be wasted work).
async function backfillVideoDerivatives(): Promise<void> {
  try {
    const orphans = await many<{ id: number }>(
      `UPDATE assets
         SET derivative_status = 'pending', updated_at = now()
       WHERE media_type = 'video'
         AND derivative_status = 'skipped'
         AND processing_state <> 'ignored'
         AND deleted_at IS NULL
       RETURNING id`,
    );
    if (orphans.length === 0) return;
    for (const a of orphans) await enqueueDerivative(a.id);
    console.log(
      `[bootstrap] re-enqueued ${orphans.length} video derivative(s) (backfill)`,
    );
  } catch (err) {
    console.error("[bootstrap] video derivative backfill failed:", err);
  }
}
