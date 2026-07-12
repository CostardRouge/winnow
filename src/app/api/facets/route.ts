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
      paired,
      livePhotos,
      ranges,
      years,
      months,
      days,
      devices,
      cameras,
      lenses,
      countries,
      regions,
      counties,
      cities,
      pois,
      faces,
      withText,
      exts,
      mediaTypes,
      derivativeStatuses,
      tags,
      sessionStatus,
    ] = await Promise.all([
      one<{ count: number }>(
        `SELECT count(*)::int AS count FROM assets a WHERE true${scope}`,
        params,
      ).catch(() => null),
      // RAW+JPEG pairing: how many assets belong to a pair (drives the
      // "RAW+JPEG" filter toggle → ?paired=1). See lib/pairing.ts.
      one<{ count: number }>(
        `SELECT count(*)::int AS count FROM assets a WHERE a.group_id IS NOT NULL${scope}`,
        params,
      ).catch(() => null),
      // Live Photos: counts the still primaries (one per pair, so this is the
      // number of items the "Live Photos" filter surfaces in the collapsed
      // gallery). Drives the filter toggle → ?group_kind=live_photo. See
      // lib/pairing.ts.
      one<{ count: number }>(
        `SELECT count(*)::int AS count FROM assets a
         WHERE a.group_role = 'primary'
           AND a.group_id IN (SELECT id FROM asset_groups WHERE kind = 'live_photo')${scope}`,
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
      // Reverse-geocoded place facets (cf. lib/geocode.ts).
      settledArray(facet("place_country", scope, params)),
      settledArray(facet("place_region", scope, params)),
      settledArray(facet("place_county", scope, params)),
      settledArray(facet("place_city", scope, params)),
      settledArray(facet("place_poi", scope, params)),
      // ML analysis facets (cf. lib/ml.ts): detected-face counts (0 included —
      // "analyzed, nobody in frame" is a meaningful pick) + how many assets
      // carry OCR-read text (drives the "Has text" toggle).
      settledArray(facet("face_count", scope, params, "value ASC")),
      one<{ count: number }>(
        `SELECT count(*)::int AS count FROM assets a
         WHERE a.ocr_text IS NOT NULL${scope}`,
        params,
      ).catch(() => null),
      settledArray(facet("ext", scope, params)),
      settledArray(facet("media_type", scope, params, "value ASC")),
      settledArray(facet("derivative_status", scope, params, "value ASC")),
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
      // Session-status facet: counts feed the Sessions grid's "Ignored" toggle.
      // Session-level (not asset-level), so scoped on roots, by role. "Done" is
      // not a hidden flag (it's the progress filter's job), so it isn't counted
      // here — only the manual ignored split.
      one<{ active: number; ignored: number }>(
        `SELECT
           count(*) FILTER (WHERE NOT s.ignored)::int AS active,
           count(*) FILTER (WHERE s.ignored)::int     AS ignored
         FROM sessions s JOIN roots rt ON rt.id = s.root_id
         ${kind ? "WHERE rt.kind = ANY($1)" : ""}`,
        kind ? [kindsForRole(kind)] : [],
      ).catch(() => null),
    ]);

    return json({
      total: total?.count ?? 0,
      paired: paired?.count ?? 0,
      live_photos: livePhotos?.count ?? 0,
      ranges: ranges ?? {},
      years,
      months,
      days,
      devices,
      camera_models: cameras,
      lenses,
      place_countries: countries,
      place_regions: regions,
      place_counties: counties,
      place_cities: cities,
      place_pois: pois,
      faces,
      with_text: withText?.count ?? 0,
      extensions: exts,
      media_types: mediaTypes,
      derivative_statuses: derivativeStatuses,
      tags,
      session_status: sessionStatus ?? { active: 0, ignored: 0 },
    });
  } catch (err) {
    return serverError(err);
  }
}
