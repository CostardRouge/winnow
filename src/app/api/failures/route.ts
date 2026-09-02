// GET /api/failures -> everything that failed, in one place, to list and
// debug. Each family is read from its own source of truth:
//   - derivative : assets.derivative_status='error' (+ derivative_error)   [retroactive]
//   - scan       : scan_failures table (per-file indexing failures)        [from now on]
//   - import     : import_batches.result.errors of failed batches          [retroactive]
//   - missing    : assets.missing_at (originals gone from disk)            [lib/integrity.ts]
// Deduplication is NOT here: its listing is thousands of rows and needs its own
// grouping/paging, so it lives at GET /api/failures/duplicates and is fetched
// only by the page that draws it (this payload is polled by every family tab).
import { many } from "@/lib/db";
import { failureCounts } from "@/lib/failures";
import { listMissing, type MissingItem } from "@/lib/integrity";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const LIMIT = 200;

export async function GET() {
  try {
    // Counts come from the shared source of truth (lib/failures) so each tab
    // matches the aggregate "Failures" badge exactly. The item lists below are
    // capped previews of those same families.
    // Missing originals: guarded like the other pre-migration families.
    const missingItems: MissingItem[] = await listMissing(LIMIT).catch(
      () => [],
    );

    const [counts, derivItems, scanItems, mlItems, batches] =
      await Promise.all([
        failureCounts(),
        many(
          // Scoped to the live library (deleted_at IS NULL) to match the count:
          // a soft-deleted error asset is gone from every triage page.
          `SELECT id AS asset_id, filename, abs_path, media_type, session_id,
                  derivative_error AS error, updated_at
             FROM assets
            WHERE derivative_status = 'error' AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT ${LIMIT}`,
        ),
        many(
          `SELECT abs_path, root_id, error, attempts, updated_at
             FROM scan_failures
            WHERE resolved_at IS NULL
            ORDER BY updated_at DESC
            LIMIT ${LIMIT}`,
        ),
        // ML analysis errors (faces/OCR/CLIP, cf. lib/ml.ts): live assets whose
        // ml_status stuck at 'error', with the message stored in ml_error.
        many(
          `SELECT id AS asset_id, filename, abs_path, media_type,
                  ml_error AS error, updated_at
             FROM assets
            WHERE ml_status = 'error' AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT ${LIMIT}`,
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

    // Flattens the per-file errors of the failed import batches (preview only —
    // the tab count is the true total from failureCounts, across every batch).
    const importItems: Array<{
      batch_id: number;
      origin: string | null;
      file: string;
      error: string;
      created_at: string;
    }> = [];
    for (const b of batches) {
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
      derivative: { count: counts.derivative, items: derivItems },
      scan: { count: counts.scan, items: scanItems },
      import: { count: counts.import, items: importItems },
      ml: { count: counts.ml, items: mlItems },
      missing: { count: counts.missing, items: missingItems },
    });
  } catch (err) {
    return serverError(err);
  }
}
