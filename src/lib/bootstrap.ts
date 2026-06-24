// Idempotent registration of known roots, run at worker startup.
//  - the incoming (kind='source'): guarantees indexing even without a recent import;
//  - each configured final folder (kind='finals'): indexed for viewing
//    (thumbnails), never culled — read-only is enforced on the UI side.
// Without this bootstrap, a final folder would stay empty: previously the
// 'finals' roots were never indexed.
import { stat } from "node:fs/promises";
import { many, one } from "./db";
import { config } from "./config";
import {
  coalescePendingIndexJobs,
  enqueueDerivative,
  enqueueIndex,
  enqueueMl,
} from "./queue";
import { isWalkable } from "./volumes";
import type { Root } from "./types";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureRoot(path: string, kind: Root["kind"]): Promise<void> {
  const root = await one<{ id: number }>(
    `INSERT INTO roots (path, kind, watch) VALUES ($1, $2, true)
     ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`,
    [path, kind],
  );
  // Only walkable volumes (source/finals) are indexed; the export volume is
  // registered for visibility in the Volumes table but never scanned.
  if (root && isWalkable(kind)) await enqueueIndex(root.id);
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
      console.log(`[bootstrap] ${kind} registered + indexing enqueued: ${path}`);
    } catch (err) {
      console.error(`[bootstrap] failure ${path}:`, err);
    }
  }

  await recoverStuckProcessing();
  await backfillVideoDerivatives();
  await backfillMlAnalysis();
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

// Back-fill the ML-analysis pass over an existing library: every ready photo
// that has no asset_analysis row yet (or whose row never completed) is enqueued.
// It reads the proxy, never the RAW, so this is safe to run on every startup —
// once a photo is analysed it stops matching, so a later boot finds nothing.
// Bounded to a cap per boot so a fresh 30k library doesn't flood the queue in
// one go (the per-hour ML rate further drip-feeds it).
async function backfillMlAnalysis(): Promise<void> {
  if (!config.ml.enabled) return;
  try {
    const todo = await many<{ id: number }>(
      `SELECT a.id
         FROM assets a
         LEFT JOIN asset_analysis aa ON aa.asset_id = a.id
        WHERE a.media_type = 'photo'
          AND a.derivative_status = 'ready'
          AND a.processing_state <> 'ignored'
          AND a.deleted_at IS NULL
          AND (aa.asset_id IS NULL OR aa.ml_status NOT IN ('ready','processing'))
        ORDER BY a.id
        LIMIT 20000`,
    );
    if (todo.length === 0) return;
    for (const a of todo) await enqueueMl(a.id);
    console.log(`[bootstrap] enqueued ${todo.length} photo(s) for ML analysis (backfill)`);
  } catch (err) {
    console.error("[bootstrap] ML analysis backfill failed:", err);
  }
}
