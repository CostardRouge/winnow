// Idempotent registration of known roots, run at worker startup.
//  - the incoming (kind='source'): guarantees indexing even without a recent import;
//  - each configured final folder (kind='finals'): indexed for viewing
//    (thumbnails), never culled — read-only is enforced on the UI side.
// Without this bootstrap, a final folder would stay empty: previously the
// 'finals' roots were never indexed.
import { stat } from "node:fs/promises";
import { one } from "./db";
import { config } from "./config";
import { enqueueIndex } from "./queue";

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
}
