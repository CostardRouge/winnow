// Idempotent registration of known roots, run at worker startup.
//  - the incoming (kind='source'): guarantees indexing even without a recent import;
//  - each configured final folder (kind='finals'): indexed for viewing
//    (thumbnails), never culled — read-only is enforced on the UI side.
// Without this bootstrap, a final folder would stay empty: previously the
// 'finals' roots were never indexed.
import { stat } from "node:fs/promises";
import { many, one } from "./db";
import { config } from "./config";
import { enqueueDerivative, enqueueIndex } from "./queue";
import { createLogger } from "./log";

const log = createLogger("bootstrap");

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureRoot(path: string, kind: "source" | "finals"): Promise<void> {
  const root = await one<{ id: number }>(
    `INSERT INTO roots (path, kind, watch) VALUES ($1, $2, true)
     ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`,
    [path, kind],
  );
  if (root) await enqueueIndex(root.id);
}

export async function bootstrapRoots(): Promise<void> {
  const { incomingDir, finalsDirs } = config.import;
  const dirs: Array<{ path: string; kind: "source" | "finals" }> = [];
  if (incomingDir) dirs.push({ path: incomingDir, kind: "source" });
  for (const d of finalsDirs) dirs.push({ path: d, kind: "finals" });

  for (const { path, kind } of dirs) {
    if (!(await exists(path))) {
      log.warn("root not found, ignored", { kind, path });
      continue;
    }
    try {
      await ensureRoot(path, kind);
      log.info("root registered + indexing enqueued", { kind, path });
    } catch (err) {
      log.error("root registration failed", { path, err });
    }
  }

  await backfillVideoDerivatives();
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
    log.info("re-enqueued video derivatives (backfill)", {
      count: orphans.length,
    });
  } catch (err) {
    log.error("video derivative backfill failed", { err });
  }
}
