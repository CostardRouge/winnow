// GET /api/sessions?kind=incoming|final&<filters>&sort=...&sort_dir=asc|desc&progress=...
//   -> sessions + counters (ready/pending derivatives, picks/rejects/unrated) +
//      parent root kind + the most recent verdict timestamp.
//
// `kind` restricts to the role (Incoming = source/inbox, Final = finals). The
// shared gallery filters (folder/date/device/tags/...) are honoured too: a
// session is kept when it has at least one matching asset (EXISTS), so the
// Filters/Browse panel narrows the session list just like the grid. With no
// filter beyond the role, every active session of that role shows (including
// empty ones).
//
// Each session carries its computed lifecycle `status` (empty/to_sort/done) and
// the manual `ignored` flag. Ignored folders are HIDDEN by default;
// `show_ignored=true` opts them back into the list. "Done" is not a hidden flag
// — completeness visibility is governed by the `progress` filter below.
//
// TRIAGE progress: each session carries pick/reject/skip/unrated counts plus a
// `frac` (triaged ÷ total) so the UI can draw the progress bar and the Sift page
// can rank / filter by completeness. "Triaged" = picks + rejects + skips (every
// deliberate verdict); only `unrated` media are still "to sort":
//   - `progress` filter: untouched (nothing triaged) · partial (some, not all) ·
//     incomplete (untouched+partial — "still to sort") · complete (all triaged).
//   - `sort`: captured (capture date, default) · touched (most recent verdict) ·
//     progress (most/least complete) · count (number of live media in the
//     session — "least first" surfaces the shortest backlogs). `sort_dir` flips
//     each ordering.
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

    // Ignored folders drop out of the list unless explicitly opted back in.
    // "Done" sessions are NOT hidden here: completeness visibility is the job of
    // the `progress` filter below (All / "to sort" / Done), so the two never
    // disagree.
    // A session with an export still queued/running stays visible even once
    // ignored, so a long export isn't hidden mid-flight; it drops out on the next
    // poll after the job finishes.
    const showIgnored = sp.get("show_ignored") === "true";
    params.push(showIgnored);
    clauses.push(
      `(s.ignored = false OR $${params.length}
        OR EXISTS (SELECT 1 FROM export_jobs j
                    WHERE j.session_id = s.id AND j.status IN ('queued','running')))`,
    );

    // Triage-progress filter, expressed against the counters in the `d`
    // subquery below (LEFT JOIN → COALESCE the NULLs of an empty session to 0).
    // No user input is interpolated, so these fixed fragments are injection-safe.
    // "Triaged" counts every deliberate verdict (pick + reject + skip); the only
    // bucket that keeps a session "to sort" is `unrated`.
    const triaged =
      "(COALESCE(d.picks,0) + COALESCE(d.rejects,0) + COALESCE(d.skips,0))";
    const total = `(${triaged} + COALESCE(d.unrated,0))`;
    switch (sp.get("progress")) {
      case "untouched":
        clauses.push(`${triaged} = 0`);
        break;
      case "partial":
        clauses.push(`${triaged} > 0 AND ${triaged} < ${total}`);
        break;
      case "incomplete":
        clauses.push(`${triaged} < ${total}`);
        break;
      case "complete":
        clauses.push(`${total} > 0 AND ${triaged} = ${total}`);
        break;
    }

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

    // Ordering: capture timeline (default), last-touched (most recent verdict),
    // triage completeness, or media count. `dir` flips each. NULLS LAST keeps
    // never-touched / empty sessions at the tail whichever direction is chosen.
    // `count` ranks by the live-media tally (COALESCE'd to 0), so flipping the
    // direction to "least first" puts the shortest sessions on top.
    const orderBy =
      sp.get("sort") === "touched"
        ? `d.last_reviewed ${dir} NULLS LAST, s.id ${dir}`
        : sp.get("sort") === "progress"
          ? `d.frac ${dir} NULLS LAST, s.id ${dir}`
          : sp.get("sort") === "count"
            ? `COALESCE(d.live, 0) ${dir}, s.id ${dir}`
            : `s.captured_at_max ${dir} NULLS LAST, s.id ${dir}`;

    const sessions = await many(
      `SELECT
         s.*,
         rt.kind AS root_kind,
         COALESCE(d.ready, 0)   AS ready_count,
         COALESCE(d.pending, 0) AS pending_count,
         COALESCE(d.error, 0)   AS error_count,
         COALESCE(d.picks, 0)   AS pick_count,
         COALESCE(d.rejects, 0) AS reject_count,
         COALESCE(d.skips, 0)   AS skip_count,
         COALESCE(d.unrated, 0) AS unrated_count,
         -- Computed lifecycle: empty (no live media) · done (every media has a
         -- verdict) · to_sort (some still unrated). Orthogonal to s.ignored.
         CASE
           WHEN COALESCE(d.live, 0) = 0     THEN 'empty'
           WHEN COALESCE(d.unrated, 0) = 0  THEN 'done'
           ELSE 'to_sort'
         END                    AS status,
         d.last_reviewed        AS last_reviewed_at,
         -- Companion pairs present in the session (drives which export options the
         -- modal offers): RAW+JPEG (Sony .ARW+.HIF …) and iPhone Live Photos.
         COALESCE(g.raw_jpeg_pairs, 0)  AS raw_jpeg_pairs,
         COALESCE(g.live_photo_pairs, 0) AS live_photo_pairs,
         -- Live export status: an in-flight job (queued/running) for this session.
         -- export_count / last_exported_at ride along via s.* (persistent history).
         EXISTS (SELECT 1 FROM export_jobs j
                  WHERE j.session_id = s.id
                    AND j.status IN ('queued','running')) AS exporting,
         COALESCE(samp.sample, '[]'::jsonb) AS sample_assets
       FROM sessions s
       JOIN roots rt ON rt.id = s.root_id
       LEFT JOIN (
         SELECT
           a.session_id,
           count(*)                                                                    AS live,
           count(*) FILTER (WHERE a.derivative_status = 'ready')                       AS ready,
           count(*) FILTER (WHERE a.derivative_status IN ('pending','processing'))     AS pending,
           count(*) FILTER (WHERE a.derivative_status = 'error')                       AS error,
           count(*) FILTER (WHERE r.verdict = 'pick')                                  AS picks,
           count(*) FILTER (WHERE r.verdict = 'reject')                                AS rejects,
           count(*) FILTER (WHERE r.verdict = 'skip')                                  AS skips,
           count(*) FILTER (WHERE r.verdict IS NULL OR r.verdict = 'unrated')          AS unrated,
           max(r.reviewed_at)                                                          AS last_reviewed,
           -- Fraction triaged (every verdict ÷ all media); NULL for an empty
           -- session so NULLS LAST parks it at the end of a progress sort.
           (count(*) FILTER (WHERE r.verdict IN ('pick','reject','skip')))::float
             / NULLIF(count(*), 0)                                                     AS frac
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         WHERE a.deleted_at IS NULL
         GROUP BY a.session_id
       ) d ON d.session_id = s.id
       -- Companion-pair tallies per session, so the export modal can show the
       -- RAW+JPEG / Live Photo options only when the session actually has them.
       LEFT JOIN (
         SELECT session_id,
                count(*) FILTER (WHERE kind = 'raw_jpeg')   AS raw_jpeg_pairs,
                count(*) FILTER (WHERE kind = 'live_photo')  AS live_photo_pairs
         FROM asset_groups
         GROUP BY session_id
       ) g ON g.session_id = s.id
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
             AND a.deleted_at IS NULL
           ORDER BY a.captured_at ASC NULLS LAST, a.id ASC
           LIMIT 8
         ) x
       ) samp ON true
       ${where}
       ORDER BY ${orderBy}`,
      params,
    );
    return json({ sessions });
  } catch (err) {
    return serverError(err);
  }
}
