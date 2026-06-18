// GET /api/assets/:id/exports → lignage (finaux liés à cet original) (§8).
import { many } from "@/lib/db";
import { json, serverError } from "@/lib/api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const exports = await many(
      `SELECT e.*, j.name AS job_name, j.target AS job_target
       FROM exports e
       LEFT JOIN export_jobs j ON j.id = e.export_job_id
       WHERE e.source_asset_id = $1
       ORDER BY e.created_at DESC`,
      [Number.parseInt(id, 10)],
    );
    return json({ exports });
  } catch (err) {
    return serverError(err);
  }
}
