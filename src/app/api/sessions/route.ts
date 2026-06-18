// GET /api/sessions → liste des sessions + compteurs (dérivés prêts/en attente, picks).
import { many } from "@/lib/db";
import { json, serverError } from "@/lib/api";

// Route adossée à la DB : jamais pré-rendue/mise en cache au build.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await many(
      `SELECT
         s.*,
         COALESCE(d.ready, 0)   AS ready_count,
         COALESCE(d.pending, 0) AS pending_count,
         COALESCE(d.error, 0)   AS error_count,
         COALESCE(d.picks, 0)   AS pick_count
       FROM sessions s
       LEFT JOIN (
         SELECT
           a.session_id,
           count(*) FILTER (WHERE a.derivative_status = 'ready')                       AS ready,
           count(*) FILTER (WHERE a.derivative_status IN ('pending','processing'))     AS pending,
           count(*) FILTER (WHERE a.derivative_status = 'error')                       AS error,
           count(*) FILTER (WHERE r.verdict = 'pick')                                  AS picks
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         GROUP BY a.session_id
       ) d ON d.session_id = s.id
       ORDER BY s.captured_at_max DESC NULLS LAST, s.id DESC`,
    );
    return json({ sessions });
  } catch (err) {
    return serverError(err);
  }
}
