// GET /api/sessions?kind=incoming|final&<filters>&sort_dir=asc|desc
//   -> sessions + counters (ready/pending derivatives, picks) + parent root kind.
//
// `kind` restricts to the role (Incoming = source/inbox, Final = finals). The
// shared gallery filters (folder/date/device/tags/...) are honoured too: a
// session is kept when it has at least one matching asset (EXISTS), so the
// Filters/Browse panel narrows the session list just like the grid. With no
// filter beyond the role, every active session of that role shows (including
// empty ones). `sort_dir` flips the captured-date ordering (newest vs oldest
// first).
//
// Session STATUS (ignored / completed) is a session-level flag, not an asset
// filter: both are HIDDEN by default. `show_ignored=true` / `show_completed=true`
// opt those sessions back into the list (additively).
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { json, serverError, badRequest } from "@/lib/api";
import { kindsForRole } from "@/lib/roles";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const role = sp.get("kind");
    const dir = sp.get("sort_dir") === "asc" ? "ASC" : "DESC";

    const params: unknown[] = [];
    const clauses: string[] = [];
    if (role === "incoming" || role === "final") {
      params.push(kindsForRole(role));
      clauses.push(`rt.kind = ANY($${params.length})`);
    }

    // Session status: ignored and completed sessions drop out of the list
    // unless explicitly opted back in. Each toggle relaxes its own exclusion,
    // so the two are independent (and additive when both are on).
    const showIgnored = sp.get("show_ignored") === "true";
    const showCompleted = sp.get("show_completed") === "true";
    params.push(showIgnored);
    clauses.push(`(s.ignored = false OR $${params.length})`);
    params.push(showCompleted);
    clauses.push(`(s.completed = false OR $${params.length})`);

    // Asset-level filters: the role is handled above (rt.kind), so drop `kind`
    // here and keep a session when at least one of its assets matches the rest.
    let filter;
    try {
      filter = filterFromSearchParams(sp);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }
    delete filter.kind;
    const { conditions, params: fp } = buildFilter(filter, params.length + 1);
    // buildFilter always emits the `deleted_at IS NULL` guard; anything beyond
    // it means the user actually picked a filter, so scope the list with EXISTS.
    if (conditions.length > 1) {
      params.push(...fp);
      clauses.push(
        `EXISTS (
           SELECT 1 FROM assets a
           LEFT JOIN ratings r ON r.asset_id = a.id
           WHERE a.session_id = s.id AND ${conditions.join(" AND ")})`,
      );
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const sessions = await many(
      `SELECT
         s.*,
         rt.kind AS root_kind,
         COALESCE(d.ready, 0)   AS ready_count,
         COALESCE(d.pending, 0) AS pending_count,
         COALESCE(d.error, 0)   AS error_count,
         COALESCE(d.picks, 0)   AS pick_count,
         COALESCE(samp.sample, '[]'::jsonb) AS sample_assets
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
       -- A handful of ready thumbnails (earliest first) to preview the session,
       -- carrying each file's extension + media type so the strip can badge them.
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object('id', x.id, 'ext', x.ext, 'media_type', x.media_type)
                ) AS sample
         FROM (
           SELECT a.id, a.ext, a.media_type
           FROM assets a
           WHERE a.session_id = s.id AND a.derivative_status = 'ready'
           ORDER BY a.captured_at ASC NULLS LAST, a.id ASC
           LIMIT 8
         ) x
       ) samp ON true
       ${where}
       ORDER BY s.captured_at_max ${dir} NULLS LAST, s.id ${dir}`,
      params,
    );
    return json({ sessions });
  } catch (err) {
    return serverError(err);
  }
}
