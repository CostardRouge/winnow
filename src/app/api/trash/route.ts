// GET /api/trash → summary for the Trash view:
//   - trash  : soft-deleted, not-yet-purged assets (count + reclaimable bytes);
//   - rejects: rejected shots still in the live library (count + bytes) — the
//     "Move all rejects to trash" shortcut targets exactly these;
//   - purged : how many originals have already been freed (lifetime);
//   - jobs   : the latest purge jobs (status + freed bytes) for live feedback.
import { many, one } from "@/lib/db";
import { config } from "@/lib/config";
import { json, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await one<{
      trash_count: number;
      trash_bytes: number;
      purged_count: number;
      reject_count: number;
      reject_bytes: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE a.deleted_at IS NOT NULL AND a.purged_at IS NULL)        AS trash_count,
         COALESCE(sum(a.file_size) FILTER (WHERE a.deleted_at IS NOT NULL AND a.purged_at IS NULL), 0) AS trash_bytes,
         count(*) FILTER (WHERE a.purged_at IS NOT NULL)                                  AS purged_count,
         count(*) FILTER (WHERE r.verdict = 'reject' AND a.deleted_at IS NULL)            AS reject_count,
         COALESCE(sum(a.file_size) FILTER (WHERE r.verdict = 'reject' AND a.deleted_at IS NULL), 0) AS reject_bytes
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id`,
    );

    const jobs = await many(
      `SELECT id, status, result, created_at, finished_at
         FROM purge_jobs
        ORDER BY created_at DESC
        LIMIT 5`,
    );

    return json({
      enabled: config.purge.enabled,
      trash: {
        count: Number(counts?.trash_count ?? 0),
        bytes: Number(counts?.trash_bytes ?? 0),
      },
      rejects: {
        count: Number(counts?.reject_count ?? 0),
        bytes: Number(counts?.reject_bytes ?? 0),
      },
      purged: { count: Number(counts?.purged_count ?? 0) },
      jobs,
    });
  } catch (err) {
    return serverError(err);
  }
}
