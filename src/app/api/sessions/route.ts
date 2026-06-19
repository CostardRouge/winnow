// GET /api/sessions?kind=incoming|final -> sessions + counters (ready/pending
// derivatives, picks) + the parent root's kind. The optional `kind` parameter
// restricts to the role (Incoming = source/inbox, Final = finals).
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { json, serverError } from "@/lib/api";
import { kindsForRole } from "@/lib/roles";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const role = req.nextUrl.searchParams.get("kind");
    const params: unknown[] = [];
    let whereKind = "";
    if (role === "incoming" || role === "final") {
      params.push(kindsForRole(role));
      whereKind = `WHERE rt.kind = ANY($1)`;
    }

    const sessions = await many(
      `SELECT
         s.*,
         rt.kind AS root_kind,
         COALESCE(d.ready, 0)   AS ready_count,
         COALESCE(d.pending, 0) AS pending_count,
         COALESCE(d.error, 0)   AS error_count,
         COALESCE(d.picks, 0)   AS pick_count
       FROM sessions s
       JOIN roots rt ON rt.id = s.root_id
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
       ${whereKind}
       ORDER BY s.captured_at_max DESC NULLS LAST, s.id DESC`,
      params,
    );
    return json({ sessions });
  } catch (err) {
    return serverError(err);
  }
}
