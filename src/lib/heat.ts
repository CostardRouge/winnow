// Heatmap aggregates — the two reads behind /heatmap.
//
// Both take the gallery's cumulative filters (lib/filter.ts), so every reading
// of the heatmap is filterable by everything the grid is, and both collapse
// RAW+JPEG pairs and burst stacks the way the Calendar does — otherwise a day's
// count would not match the grid the day drills into.
//
// ## One scan each, and why that mattered more than expected
//
// Each read is a SINGLE statement over one `scoped` CTE. The first version used
// four small queries per route (days, tints, bounds, undated) and took 5.5 s on
// an 87k-row library; the same work as one scan is ~40 ms. Two findings behind
// that, both worth keeping:
//
//   1. **`collapseGroups` puts the plan over `jit_above_cost`.** Its burst
//      predicate carries a correlated subquery, which inflates the estimated
//      cost enough that Postgres LLVM-compiles the expression — measured at
//      1058 ms with JIT on and 28 ms with it off, on a plan whose subplan is
//      never even executed. So every statement here runs with `SET LOCAL
//      jit = off`. This is NOT specific to the heatmap: any query carrying
//      `collapseGroups` over a large scope pays it, and the gallery/calendar
//      only escape by windowing to a page or a month. See
//      `docs/memory/database.md`.
//   2. Four queries meant paying that cost four times. One scan pays it once —
//      which is the Timeline's rule ("one ordered SQL scan") arrived at again
//      from the other end.
//
// ## What is deliberately NOT here
//
// **No cover thumbnail per day.** That is the expensive half of
// /api/assets/calendar (a `DISTINCT ON` per day) and an 11-pixel cell cannot
// show one.
//
// **No spatial clustering.** The bins already exist: reverse geocoding snaps
// every coordinate to `places(cell_lat, cell_lon, precision_m)` at ingest time
// (lib/geocode.ts, the `geocodePrecisionM` setting — 5 km by default), the
// triple is uniquely indexed, and `assets.place_id` points at it. So a named
// distribution is one GROUP BY, with no PostGIS and no clustering pass. The
// cost is that the bin size is the geocoding cell size and does not refine on
// zoom; a finer `round(lat/step)` grid over `assets_gps_coords_idx` is the
// documented next step, not a thing this version half-does.
import type pg from "pg";
import { tx } from "./db";
import { buildFilter, type PartialAssetFilter } from "./filter";
import type { HeatCell } from "./heatScale";

/** How many places the map and the matrix carry before the tail is folded. */
const PLACE_LIMIT = 14;

export type HeatDay = HeatCell & {
  /** Capture date, `YYYY-MM-DD`, read in UTC (see the note in the route). */
  d: string;
  /**
   * The day's *most frequent* place id, so a travel day shared between two legs
   * takes the one it actually shot in; `null` for a day with no position at
   * all. The client resolves it to a tint slot against the places read — the
   * two payloads are ordered by the same rule, so they agree.
   */
  pl: number | null;
};

export type HeatDays = {
  days: HeatDay[];
  /** Media the library holds but cannot place in time. Counted, never dropped. */
  undated: HeatCell;
};

export type HeatPlaceMonth = HeatCell & { ym: string };

export type HeatPlace = HeatCell & {
  id: number;
  name: string;
  lat: number;
  lon: number;
  months: HeatPlaceMonth[];
};

export type HeatPlaces = {
  /** Busiest first — the order the tint slots are assigned in. */
  places: HeatPlace[];
  /** Everything past `PLACE_LIMIT`, folded — so the totals still add up. */
  other: (HeatCell & { months: HeatPlaceMonth[] }) | null;
  /** Media with no position. Counted, never dropped. */
  untagged: HeatCell & { months: HeatPlaceMonth[] };
  /** The geocoding cell size these bins are, in metres. */
  precisionM: number | null;
};

// The two tallies every read shares beside the count. `unrated` counts a
// missing ratings row too — an asset nobody has looked at usually has none.
const TALLY = `count(*)::int AS c,
   count(*) FILTER (WHERE v = 'pick')::int AS p,
   count(*) FILTER (WHERE v = 'unrated')::int AS u`;

/** The place's human name, in the order a bin label should prefer them. */
const PLACE_NAME = `COALESCE(pl.city, pl.county, pl.region, pl.country, pl.display_name)`;

function scope(filter: PartialAssetFilter) {
  const { conditions, params } = buildFilter(filter, 1, { collapseGroups: true });
  return { where: conditions.join(" AND "), params };
}

/**
 * One statement, on a connection where JIT is off for the duration (see the
 * header). `tx` is otherwise reserved for all-or-nothing writes; a read uses it
 * here purely because `SET LOCAL` needs a transaction to be local to.
 */
async function scan<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[],
): Promise<T[]> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");
    const r = await client.query<T>(text, params as never[]);
    return r.rows;
  });
}

/** Per-day tallies plus the undated pile — one scan. */
export async function heatDays(
  filter: PartialAssetFilter,
  /** Narrow to one place bin: the map's click-through. */
  placeId?: number | null,
): Promise<HeatDays> {
  const { where, params } = scope(filter);
  const all = [...params];
  let sql = where;
  if (placeId != null) {
    all.push(placeId);
    sql = `${where} AND a.place_id = $${all.length}`;
  }

  // Grouping by `capture_date` yields a NULL group for the undated pile, so it
  // comes back from the same scan instead of a second query.
  const rows = await scan<{
    d: string | null;
    c: number;
    p: number;
    u: number;
    pl: number | null;
  }>(
    `WITH scoped AS (
       SELECT a.capture_date AS d, a.place_id,
              COALESCE(r.verdict, 'unrated') AS v
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${sql}
     )
     SELECT to_char(d, 'YYYY-MM-DD') AS d, ${TALLY},
            mode() WITHIN GROUP (ORDER BY place_id)
              FILTER (WHERE place_id IS NOT NULL) AS pl
     FROM scoped
     GROUP BY d
     ORDER BY d NULLS LAST`,
    all,
  );

  const days: HeatDay[] = [];
  let undated: HeatCell = { c: 0, p: 0, u: 0 };
  for (const r of rows) {
    if (r.d === null) undated = { c: r.c, p: r.p, u: r.u };
    else days.push({ d: r.d, c: r.c, p: r.p, u: r.u, pl: r.pl });
  }
  return { days, undated };
}

/** Per-place tallies by month — one scan, serving both the map and the matrix. */
export async function heatPlaces(
  filter: PartialAssetFilter,
): Promise<HeatPlaces> {
  const { where, params } = scope(filter);

  // `bucket` is a plain integer so the grouping stays on one key: the place id
  // for a top place, -1 for the folded tail, 0 for "no position".
  const rows = await scan<{
    bucket: number;
    ym: string;
    c: number;
    p: number;
    u: number;
    name: string | null;
    lat: number | null;
    lon: number | null;
    precision_m: number | null;
    total: number | null;
  }>(
    `WITH scoped AS MATERIALIZED (
       SELECT a.place_id, a.capture_date,
              COALESCE(r.verdict, 'unrated') AS v
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${where}
     ),
     top AS (
       SELECT place_id, count(*)::int AS total
       FROM scoped
       WHERE place_id IS NOT NULL
       GROUP BY place_id
       ORDER BY total DESC
       LIMIT ${PLACE_LIMIT}
     ),
     bucketed AS (
       SELECT CASE
                WHEN s.place_id IS NULL THEN 0
                WHEN t.place_id IS NOT NULL THEN s.place_id
                ELSE -1
              END AS bucket,
              to_char(date_trunc('month', s.capture_date), 'YYYY-MM') AS ym,
              ${TALLY}
       FROM scoped s
       LEFT JOIN top t ON t.place_id = s.place_id
       WHERE s.capture_date IS NOT NULL
       GROUP BY 1, 2
     )
     SELECT b.bucket, b.ym, b.c, b.p, b.u,
            ${PLACE_NAME} AS name,
            pl.cell_lat AS lat, pl.cell_lon AS lon, pl.precision_m,
            t.total
     FROM bucketed b
     LEFT JOIN places pl ON pl.id = b.bucket
     LEFT JOIN top t ON t.place_id = b.bucket
     ORDER BY b.ym`,
    params,
  );

  const sum = (ms: HeatPlaceMonth[]): HeatCell =>
    ms.reduce((o, m) => ({ c: o.c + m.c, p: o.p + m.p, u: o.u + m.u }),
              { c: 0, p: 0, u: 0 });

  const byBucket = new Map<
    number,
    { months: HeatPlaceMonth[]; name: string | null; lat: number | null;
      lon: number | null; precision: number | null; total: number }
  >();
  for (const r of rows) {
    let e = byBucket.get(r.bucket);
    if (!e) {
      e = { months: [], name: r.name, lat: r.lat, lon: r.lon,
            precision: r.precision_m, total: r.total ?? 0 };
      byBucket.set(r.bucket, e);
    }
    e.months.push({ ym: r.ym, c: r.c, p: r.p, u: r.u });
  }

  const places: HeatPlace[] = [];
  for (const [bucket, e] of byBucket) {
    if (bucket <= 0 || e.lat == null || e.lon == null) continue;
    places.push({
      id: bucket,
      name: e.name?.trim() || "Unnamed place",
      lat: e.lat,
      lon: e.lon,
      months: e.months,
      ...sum(e.months),
    });
  }
  // Busiest first: the map draws them in this order and the client assigns tint
  // slots from the head, so the calendar's stripes match the matrix's dots.
  places.sort((a, b) => b.c - a.c);

  const tail = byBucket.get(-1);
  const none = byBucket.get(0);

  return {
    places,
    other: tail ? { months: tail.months, ...sum(tail.months) } : null,
    untagged: none
      ? { months: none.months, ...sum(none.months) }
      : { months: [], c: 0, p: 0, u: 0 },
    precisionM: places.length
      ? (byBucket.get(places[0].id)?.precision ?? null)
      : null,
  };
}
