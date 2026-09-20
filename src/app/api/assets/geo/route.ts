// GET /api/assets/geo ?<cumulative filters> → lightweight GPS points for the
// map view: just { id, lat, lon } for every geotagged asset matching the
// filters. Not paginated (the map plots the whole set at once) but capped, so a
// huge library can't blow up the payload; `truncated` flags when the cap is hit.
//
// Clips also carry `video: true` so the marker popover can offer inline playback
// the moment it opens, without waiting on the per-asset detail fetch. It is
// OMITTED (rather than `false`) on photos: at the 10k cap, a key repeated on
// every point is payload the phone pays for on every filter change.
//
// ## `?by=day` — the per-capture-day aggregate
//
// `GET /api/assets/geo?<same cumulative filters>&by=day` answers
// `{ days: [{ date, lat, lon, count, measured, source }] }` instead of points.
// It exists for Atelier (the sibling editing app), which used to call
// /api/assets/calendar and then one `geo?date_from=D&date_to=D` per day — dozens
// of round trips for one screen. This is a cross-repo contract: the shape below
// is agreed with that team, so change it additively or not at all. The
// pre-existing (no `by`) branch is untouched and still answers
// `{ points, truncated }`.
//
// **Trustworthy positions first, and why.** `assets.gps_source` is NULL when the
// coordinates came from the file itself (camera EXIF, DJI .SRT) and 'manual'
// when a human placed them deliberately; a migration landing in parallel adds a
// third value, 'inferred', for a position accepted in bulk from a same-day /
// nearby-day machine suggestion. The query is already written for it. A day's
// position is the MEDIAN of its trustworthy rows only — NULL or 'manual', never
// 'inferred' — and `source` is then "measured". Only a day with no trustworthy
// row at all falls back to the median of whatever positions it has, reported as
// "inferred". The rule is not cosmetic: a day with 5 real fixes and 800
// bulk-accepted suggestions must be placed by the 5, or accuracy would silently
// decay as more bulk geotagging happens. Do not "simplify" this to one average
// over every located row. The median (not the mean) keeps one frame shot on the
// road from dragging the day's point across the map.
//
// A day that matches the filters but holds no position at all is a **declared
// gap**: it is still emitted, with `lat`/`lon`/`source` null. Atelier reads that
// as "no data for this day", which is not the same as "no assets that day" — the
// latter simply produces no row, as on /api/assets/calendar.
//
// **`capture_date` verbatim.** Days are grouped on the stored `a.capture_date`
// column, never derived from `captured_at` and never passed through timezone
// math: a frame shot at 07:00 local can be a different UTC day, and recomputing
// would quietly file it under the wrong one. Project-wide rule.
import { NextRequest } from "next/server";
import { many, tx } from "@/lib/db";
import {
  buildFilter,
  filterFromSearchParams,
  type PartialAssetFilter,
} from "@/lib/filter";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

const CAP = 10000;

/** One row of the `?by=day` answer. See the header for the rules behind it. */
type GeoDay = {
  /** `YYYY-MM-DD`, straight out of `assets.capture_date`. */
  date: string;
  /** Median of the day's chosen rows; null on a declared gap. */
  lat: number | null;
  lon: number | null;
  /** Live assets matching the filters that day, positioned or not. */
  count: number;
  /** Of those, how many carry a trustworthy (non-'inferred') position. */
  measured: number;
  source: "measured" | "inferred" | null;
};

/**
 * Per-capture-day GPS aggregate — one scan, no cap (the output is bounded by
 * the number of distinct days, not by asset count, so `CAP`/`truncated` belong
 * to the points branch alone).
 *
 * JIT is off for the statement, the rule `docs/memory/database.md` states for
 * any aggregate that can plausibly scan the whole `assets` table — which this
 * one does whenever the caller passes broad or no filters. `tx` is used purely
 * because `SET LOCAL` needs a transaction to be local to (same reasoning as
 * `scan()` in `src/lib/heat.ts`).
 *
 * The filters are consumed exactly as the points branch consumes them (no
 * `collapseGroups`): `count` is therefore assets, RAW+JPEG companions included,
 * and `deleted_at IS NULL` already comes from `buildFilter`.
 *
 * lat and lon are median'd independently, as `src/lib/timeline.ts` does: the
 * result is a marker position for the day, not the position of any one asset.
 */
async function geoByDay(filter: PartialAssetFilter) {
  const { conditions, params } = buildFilter(filter, 1);
  const where = conditions.join(" AND ");

  const days = await tx(async (client) => {
    await client.query("SET LOCAL jit = off");
    const res = await client.query<GeoDay>(
      `WITH scoped AS (
         SELECT a.capture_date, a.gps_lat, a.gps_lon,
                -- 'inferred' (a bulk-accepted suggestion; the value arrives
                -- with a migration in flight) is deliberately NOT trustworthy.
                (a.gps_lat IS NOT NULL
                 AND (a.gps_source IS NULL OR a.gps_source = 'manual')) AS trusted
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         WHERE ${where} AND a.capture_date IS NOT NULL
       )
       SELECT to_char(capture_date, 'YYYY-MM-DD') AS date,
              count(*)::int AS count,
              count(*) FILTER (WHERE trusted)::int AS measured,
              -- Trustworthy rows decide the point; the located rest is only a
              -- fallback for a day that has no trustworthy row at all. A day
              -- with neither keeps NULL here: a declared gap, still emitted.
              COALESCE(
                percentile_cont(0.5) WITHIN GROUP (ORDER BY gps_lat)
                  FILTER (WHERE trusted),
                percentile_cont(0.5) WITHIN GROUP (ORDER BY gps_lat)
                  FILTER (WHERE gps_lat IS NOT NULL)
              ) AS lat,
              COALESCE(
                percentile_cont(0.5) WITHIN GROUP (ORDER BY gps_lon)
                  FILTER (WHERE trusted),
                percentile_cont(0.5) WITHIN GROUP (ORDER BY gps_lon)
                  FILTER (WHERE gps_lon IS NOT NULL)
              ) AS lon,
              CASE
                WHEN count(*) FILTER (WHERE trusted) > 0 THEN 'measured'
                WHEN count(*) FILTER (WHERE gps_lat IS NOT NULL) > 0 THEN 'inferred'
                ELSE NULL
              END AS source
       FROM scoped
       GROUP BY capture_date
       ORDER BY capture_date`,
      params as never[],
    );
    return res.rows;
  });

  return json({ days });
}

export async function GET(req: NextRequest) {
  try {
    let filter;
    try {
      filter = filterFromSearchParams(req.nextUrl.searchParams);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }

    if (req.nextUrl.searchParams.get("by") === "day") return geoByDay(filter);

    const { conditions, params } = buildFilter(filter, 1);
    // Only geotagged assets land on the map.
    conditions.push(`a.gps_lat IS NOT NULL`);
    const where = `WHERE ${conditions.join(" AND ")}`;
    const idx = params.length + 1;

    const rows = await many<{
      id: number;
      lat: number;
      lon: number;
      media_type: "photo" | "video";
    }>(
      `SELECT a.id, a.gps_lat AS lat, a.gps_lon AS lon, a.media_type
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
       ORDER BY a.captured_at DESC NULLS LAST, a.id DESC
       LIMIT $${idx}`,
      [...params, CAP + 1],
    );

    const truncated = rows.length > CAP;
    const points = (truncated ? rows.slice(0, CAP) : rows).map(
      ({ id, lat, lon, media_type }) =>
        media_type === "video" ? { id, lat, lon, video: true } : { id, lat, lon },
    );
    return json({ points, truncated });
  } catch (err) {
    return serverError(err);
  }
}
