// GET /api/assets/calendar ?<cumulative filters>&from=YYYY-MM-DD&to=YYYY-MM-DD
// → per-day aggregates for the calendar view: a count and a representative
// cover thumbnail for every capture date in the [from, to] window. Also returns
// `bounds` — the full filtered date range (independent of the window) — so the
// UI can land on the month that actually holds media and clamp navigation.
import { NextRequest } from "next/server";
import { many, one } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let filter;
    try {
      filter = filterFromSearchParams(sp);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }

    const from = sp.get("from");
    const to = sp.get("to");
    if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to))
      return badRequest("from/to must be YYYY-MM-DD");

    // Collapse RAW+JPEG pairs to one logical media, matching the grid the day
    // drills into (so the count lines up and covers are display primaries, not
    // RAW companions that may lack a thumbnail).
    const { conditions, params } = buildFilter(filter, 1, { collapseGroups: true });
    const where = conditions.join(" AND ");

    // Per-day counts + a representative cover. The cover prefers an asset whose
    // derivative is ready (so the thumbnail exists), then the newest capture.
    let i = params.length + 1;
    const days = await many<{ date: string; count: number; cover_id: number }>(
      `WITH scoped AS (
         SELECT a.id, a.capture_date, a.captured_at, a.derivative_status
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         WHERE ${where}
           AND a.capture_date >= $${i++} AND a.capture_date <= $${i++}
       ),
       counts AS (
         SELECT capture_date AS date, count(*)::int AS count
         FROM scoped GROUP BY capture_date
       ),
       covers AS (
         SELECT DISTINCT ON (capture_date) capture_date AS date, id AS cover_id
         FROM scoped
         ORDER BY capture_date,
                  (derivative_status = 'ready') DESC,
                  captured_at DESC NULLS LAST,
                  id DESC
       )
       SELECT to_char(c.date, 'YYYY-MM-DD') AS date, c.count, cov.cover_id
       FROM counts c JOIN covers cov ON cov.date = c.date
       ORDER BY c.date`,
      [...params, from, to],
    );

    // Full filtered span (ignores the window) so the calendar can jump to the
    // month that holds media and disable navigation past the edges.
    const bounds = await one<{ min: string | null; max: string | null }>(
      `SELECT to_char(min(a.capture_date), 'YYYY-MM-DD') AS min,
              to_char(max(a.capture_date), 'YYYY-MM-DD') AS max
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${where} AND a.capture_date IS NOT NULL`,
      params,
    );

    return json({ days, bounds: bounds ?? { min: null, max: null } });
  } catch (err) {
    return serverError(err);
  }
}
