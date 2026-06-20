// GET /api/facets?kind=incoming|final -> available values (+ counts) to
// build the filters. Global counts (v1), optionally restricted to the
// folder role (Incoming/Final); cumulative filtering then applies on the
// results side.
import { NextRequest } from "next/server";
import { many, one } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { kindsForRole } from "@/lib/roles";
import { json, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time (otherwise Next
// runs the query at build and freezes an empty response into the image).
export const dynamic = "force-dynamic";

type ValueCount = { value: string | number; count: number };

// `scope` is a SQL fragment starting with " AND ..." (or "") that restricts the
// assets to the requested role; `params` carries its positional parameters. All
// the queries alias `assets a` so that the scope subquery (on
// `a.session_id`) resolves.
async function facet(
  column: string,
  scope: string,
  params: unknown[],
  order = "count DESC",
): Promise<ValueCount[]> {
  const rows = await many<{ value: string | number | null; count: number }>(
    `SELECT ${column} AS value, count(*)::int AS count
     FROM assets a
     WHERE ${column} IS NOT NULL${scope}
     GROUP BY ${column}
     ORDER BY ${order}`,
    params,
  );
  return rows
    .filter((r) => r.value !== null && r.value !== "")
    .map((r) => ({ value: r.value as string | number, count: r.count }));
}

// `allSettled`: a failed subquery (e.g. `tags` table absent, DB hiccup)
// returns an empty facet instead of crashing the whole endpoint -- the
// gallery stays usable and the front no longer receives an error object in
// place of the expected shape.
async function settledArray(p: Promise<ValueCount[]>): Promise<ValueCount[]> {
  const r = await Promise.allSettled([p]);
  if (r[0].status === "fulfilled") return r[0].value;
  console.error("facet error:", r[0].reason);
  return [];
}

export async function GET(req: NextRequest) {
  try {
    // Only `kind` (the role) matters here: the other dimensions are
    // facets, not a scope.
    const { kind } = filterFromSearchParams(req.nextUrl.searchParams);
    const { conditions, params } = buildFilter(kind ? { kind } : {}, 1);
    const scope = conditions.length ? ` AND ${conditions.join(" AND ")}` : "";

    const [
      total,
      ranges,
      years,
      months,
      days,
      devices,
      cameras,
      lenses,
      exts,
      mediaTypes,
      tags,
      sessionStatus,
    ] = await Promise.all([
      one<{ count: number }>(
        `SELECT count(*)::int AS count FROM assets a WHERE true${scope}`,
        params,
      ).catch(() => null),
      one<{
        size_min: number | null;
        size_max: number | null;
        iso_min: number | null;
        iso_max: number | null;
        focal_min: number | null;
        focal_max: number | null;
        aperture_min: number | null;
        aperture_max: number | null;
      }>(
        `SELECT min(file_size) size_min, max(file_size) size_max,
                min(iso) iso_min, max(iso) iso_max,
                min(focal_length) focal_min, max(focal_length) focal_max,
                min(aperture) aperture_min, max(aperture) aperture_max
         FROM assets a WHERE true${scope}`,
        params,
      ).catch(() => null),
      settledArray(facet("capture_year", scope, params, "value DESC")),
      settledArray(facet("capture_month", scope, params, "value ASC")),
      settledArray(facet("capture_day", scope, params, "value ASC")),
      settledArray(facet("device", scope, params)),
      settledArray(facet("camera_model", scope, params)),
      settledArray(facet("lens", scope, params)),
      settledArray(facet("ext", scope, params)),
      settledArray(facet("media_type", scope, params, "value ASC")),
      settledArray(
        many<{ value: string; count: number }>(
          `SELECT t.name AS value, count(*)::int AS count
           FROM asset_tags at
           JOIN tags t ON t.id = at.tag_id
           JOIN assets a ON a.id = at.asset_id
           WHERE true${scope}
           GROUP BY t.name ORDER BY count DESC`,
          params,
        ),
      ),
      // Session-status facet: counts feed the Sessions grid's hide-by-default
      // toggles. Session-level (not asset-level), so scoped on roots, by role.
      one<{ active: number; ignored: number; completed: number }>(
        `SELECT
           count(*) FILTER (WHERE NOT s.ignored AND NOT s.completed)::int AS active,
           count(*) FILTER (WHERE s.ignored)::int                        AS ignored,
           count(*) FILTER (WHERE s.completed)::int                      AS completed
         FROM sessions s JOIN roots rt ON rt.id = s.root_id
         ${kind ? "WHERE rt.kind = ANY($1)" : ""}`,
        kind ? [kindsForRole(kind)] : [],
      ).catch(() => null),
    ]);

    return json({
      total: total?.count ?? 0,
      ranges: ranges ?? {},
      years,
      months,
      days,
      devices,
      camera_models: cameras,
      lenses,
      extensions: exts,
      media_types: mediaTypes,
      tags,
      session_status: sessionStatus ?? { active: 0, ignored: 0, completed: 0 },
    });
  } catch (err) {
    return serverError(err);
  }
}
