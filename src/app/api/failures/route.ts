// GET /api/failures -> everything that failed, in one place, to list and
// debug. Three families, each read from its own source of truth:
//   - derivative : assets.derivative_status='error' (+ derivative_error)   [retroactive]
//   - scan       : scan_failures table (per-file indexing failures)        [from now on]
//   - import     : import_batches.result.errors of failed batches          [retroactive]
import { many, one } from "@/lib/db";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const LIMIT = 200;

// Deduplication audit (review §4): files matched as duplicates by partial hash.
// Guarded so a missing table (pre-migration) never breaks the other families.
async function duplicateHits() {
  try {
    const [items, counts] = await Promise.all([
      many(
        `SELECT abs_path, content_hash, existing_asset_id, source, verified,
                hits, updated_at
           FROM duplicate_hits
          ORDER BY updated_at DESC
          LIMIT ${LIMIT}`,
      ),
      one<{ n: number; false_collisions: number }>(
        `SELECT count(*) AS n,
                count(*) FILTER (WHERE verified IS FALSE) AS false_collisions
           FROM duplicate_hits`,
      ),
    ]);
    return {
      count: Number(counts?.n ?? 0),
      falseCollisions: Number(counts?.false_collisions ?? 0),
      items,
    };
  } catch {
    return { count: 0, falseCollisions: 0, items: [] };
  }
}

export async function GET() {
  try {
    const [derivItems, derivCount, scanItems, scanCount, batches] =
      await Promise.all([
        many(
          `SELECT id AS asset_id, filename, abs_path, media_type, session_id,
                  derivative_error AS error, updated_at
             FROM assets
            WHERE derivative_status = 'error'
            ORDER BY updated_at DESC
            LIMIT ${LIMIT}`,
        ),
        one<{ n: number }>(
          "SELECT count(*) AS n FROM assets WHERE derivative_status = 'error'",
        ),
        many(
          `SELECT abs_path, root_id, error, attempts, updated_at
             FROM scan_failures
            WHERE resolved_at IS NULL
            ORDER BY updated_at DESC
            LIMIT ${LIMIT}`,
        ),
        one<{ n: number }>(
          "SELECT count(*) AS n FROM scan_failures WHERE resolved_at IS NULL",
        ),
        many<{
          id: number;
          origin: string | null;
          failed: number;
          created_at: string;
          result: { errors?: Array<{ file: string; error: string }> } | null;
        }>(
          `SELECT id, origin, failed, created_at, result
             FROM import_batches
            WHERE failed > 0
            ORDER BY created_at DESC
            LIMIT 50`,
        ),
      ]);

    // Flattens the per-file errors of the failed import batches.
    const importItems: Array<{
      batch_id: number;
      origin: string | null;
      file: string;
      error: string;
      created_at: string;
    }> = [];
    let importCount = 0;
    for (const b of batches) {
      importCount += b.failed;
      for (const e of b.result?.errors ?? []) {
        if (importItems.length >= LIMIT) break;
        importItems.push({
          batch_id: b.id,
          origin: b.origin,
          file: e.file,
          error: e.error,
          created_at: b.created_at,
        });
      }
    }

    return json({
      derivative: { count: derivCount?.n ?? 0, items: derivItems },
      scan: { count: scanCount?.n ?? 0, items: scanItems },
      import: { count: importCount, items: importItems },
      duplicates: await duplicateHits(),
    });
  } catch (err) {
    return serverError(err);
  }
}
