// GET /api/exports -> export jobs + file count + sample of source assets
// (for the thumbnails, served via /api/assets/:id/thumb since each export
// points to an asset that keeps its derivatives).
import { many } from "@/lib/db";
import { json, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const jobs = await many(
      `SELECT j.id, j.name, j.target, j.status, j.created_at, j.finished_at,
              j.result,
              COALESCE(e.cnt, 0) AS export_count,
              COALESCE(e.sample, '[]'::jsonb) AS sample_asset_ids
       FROM export_jobs j
       LEFT JOIN (
         SELECT export_job_id,
                count(*)::int AS cnt,
                to_jsonb((array_agg(source_asset_id ORDER BY id))[1:8]) AS sample
         FROM exports
         GROUP BY export_job_id
       ) e ON e.export_job_id = j.id
       ORDER BY j.created_at DESC`,
    );
    return json({ jobs });
  } catch (err) {
    return serverError(err);
  }
}
