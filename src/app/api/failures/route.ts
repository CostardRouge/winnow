// GET /api/failures -> everything that failed, in one place, to list and
// debug. Each family is read from its own source of truth:
//   - derivative : assets.derivative_status='error' (+ derivative_error)   [retroactive]
//   - scan       : scan_failures table (per-file indexing failures)        [from now on]
//   - import     : import_batches.result.errors of failed batches          [retroactive]
//   - missing    : assets.missing_at (originals gone from disk)            [lib/integrity.ts]
import { many, one } from "@/lib/db";
import { failureCounts } from "@/lib/failures";
import { listMissing, type MissingItem } from "@/lib/integrity";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const LIMIT = 200;

// Deduplication audit (review §4): files matched as duplicates by partial hash.
// Guarded so a missing table (pre-migration) never breaks the other families.
async function duplicateHits() {
  try {
    const [rows, counts] = await Promise.all([
      many<{
        abs_path: string;
        content_hash: string;
        existing_asset_id: number | null;
        source: string;
        verified: boolean | null;
        hits: number;
        file_size: number | null;
        updated_at: string;
        existing_filename: string | null;
        existing_abs_path: string | null;
        existing_media_type: string | null;
        existing_has_thumb: boolean | null;
        existing_deleted: boolean | null;
      }>(
        // LEFT JOIN the kept asset so the UI can show its thumbnail (the copies
        // are identical, so its thumbnail stands in for the duplicate) and lay
        // out a kept-vs-duplicate comparison. All DB-local — no NAS I/O here
        // (the list polls every few seconds), only the explicit download/delete
        // actions ever touch the originals.
        `SELECT d.abs_path, d.content_hash, d.existing_asset_id, d.source,
                d.verified, d.hits, d.file_size, d.updated_at,
                a.filename               AS existing_filename,
                a.abs_path               AS existing_abs_path,
                a.media_type             AS existing_media_type,
                (a.thumb_key IS NOT NULL) AS existing_has_thumb,
                (a.deleted_at IS NOT NULL) AS existing_deleted
           FROM duplicate_hits d
           LEFT JOIN assets a ON a.id = d.existing_asset_id
          ORDER BY d.updated_at DESC
          LIMIT ${LIMIT}`,
      ),
      one<{ n: number; false_collisions: number }>(
        `SELECT count(*) AS n,
                count(*) FILTER (WHERE verified IS FALSE) AS false_collisions
           FROM duplicate_hits`,
      ),
    ]);
    const items = rows.map((r) => ({
      abs_path: r.abs_path,
      content_hash: r.content_hash,
      existing_asset_id: r.existing_asset_id,
      source: r.source,
      verified: r.verified,
      hits: r.hits,
      file_size: r.file_size,
      updated_at: r.updated_at,
      existing: r.existing_asset_id
        ? {
            id: r.existing_asset_id,
            filename: r.existing_filename,
            abs_path: r.existing_abs_path,
            media_type: r.existing_media_type,
            has_thumb: !!r.existing_has_thumb,
            deleted: !!r.existing_deleted,
          }
        : null,
    }));
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
    // Counts come from the shared source of truth (lib/failures) so each tab
    // matches the aggregate "Failures" badge exactly. The item lists below are
    // capped previews of those same families.
    // Missing originals: guarded like the other pre-migration families.
    const missingItems: MissingItem[] = await listMissing(LIMIT).catch(
      () => [],
    );

    const [counts, derivItems, scanItems, batches, duplicates] =
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
        duplicateHits(),
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
      duplicates,
      missing: { count: counts.missing, items: missingItems },
    });
  } catch (err) {
    return serverError(err);
  }
}
