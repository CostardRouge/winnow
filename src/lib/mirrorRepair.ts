// Repair of the positions the GPS write-back mirrored (docs/SILENT-LIMITS-AUDIT.md
// G1). Until 2026-10-09 `writeGps` handed exiftool-vendored unsigned values,
// and the library derives the hemisphere from the sign: every manual pin West
// of Greenwich or South of the equator went into the original as N/E. The next
// re-index read the file back (the file wins) and the database took the mirror
// too: whole Australian folders at 33° N in the Pacific, Saint-Quay-Portrieux
// in Seine-et-Marne. An 'inferred' suggestion drawn from such a pin inherited
// the mirror.
//
// A mirrored row cannot be told from a genuine one by itself: 33.3 N 134.8 E is
// a valid point. The evidence is elsewhere — the positions the CAMERAS
// measured in the same hours (gps_source NULL: the file's own GPS, or 'track':
// an imported log), never another placed row, which may be mirrored too. So
// the unit is a GROUP: the rows of one folder sharing one coordinate (a
// placement writes one point on a folder), and for each the MEDIAN distance
// from the evidence of its days to the point as stored and to its three sign
// flips — the median, because one stray fix (a friend's phone, a flight) must
// not decide: a minimum let a single point 104 km off pass a mirror as fine.
// The rule, printed on the screen:
//   - a flip within NEAR_KM of the evidence, and the stored point at least
//     RATIO times farther plus MARGIN_KM: mirrored, corrected to that flip.
//     A ratio, not a fixed distance: a longitude flip near Greenwich is short
//     (Saint-Quay-Portrieux ↔ Seine-et-Marne is 415 km), a latitude flip in
//     Australia is 7 000 km, and the real spot can sit tens of km from where
//     the phone was (a cave, a lookout);
//   - the stored point within NEAR_KM: fine;
//   - no evidence in the window, or none of the four near it: left alone and
//     listed, for a human to place again.
//
// Applying is database-first, like every other repair here: the position, the
// place names (nulled, re-geocoded in cell mode), the capture day (the local
// day follows the place). The originals are rewritten through the existing
// gpswrite queue — now signed — for every MANUAL photo whose file holds the
// mirror: the flipped ones, and the ones whose database row is still right
// but whose file was written N/E (West or South, written 'ready'). An
// 'inferred' row never enters a file (docs/UNPLACED.md §4.3).
import { one, tx } from "./db";
import { applyOwnZones } from "./captureDays";

export const NEAR_KM = 100;
export const RATIO = 3;
export const MARGIN_KM = 100;
/** Evidence is looked for this far either side of a group's capture times. */
export const WINDOW_H = 12;

export type MirrorVerdict = "mirrored" | "ok" | "no_evidence" | "unclear";

export type MirrorGroup = {
  sessionId: number;
  folder: string;
  media: number;
  manual: number;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number } | null;
  /** Median distance from the stored point to the evidence, km. */
  storedKm: number | null;
  /** Median distance from the chosen flip to the evidence, km. */
  flippedKm: number | null;
  evidence: number;
  verdict: MirrorVerdict;
  t0: string;
  t1: string;
};

export type MirrorReport = {
  apply: boolean;
  groups: MirrorGroup[];
  /** Media the repair corrects (mirrored groups). */
  mirrored: number;
  /** Originals to rewrite through gpswrite (manual photos whose file holds the mirror). */
  filesToRewrite: number;
  unclear: number;
  noEvidence: number;
  ok: number;
};

type Row = {
  session_id: string;
  folder: string;
  lat: number;
  lon: number;
  n: number;
  manual: number;
  t0: string;
  t1: string;
  ids: string[];
  n_ev: number;
  d0: number | null;
  d_lat: number | null;
  d_lon: number | null;
  d_both: number | null;
};

export type MirrorDeps = {
  enqueueGpsWriteBulk: (ids: number[]) => Promise<unknown>;
  enqueueGeocodeBulk: (ids: number[]) => Promise<unknown>;
};

// Equirectangular distance in km — plenty at the scale of the decision (50 km
// against thousands), with the longitude difference wrapped.
const dist = (la: string, lo: string) =>
  `111.2 * sqrt(power(${la} - e.gps_lat, 2) + power(cos(radians((${la} + e.gps_lat) / 2)) *
     least(abs(${lo} - e.gps_lon), 360 - abs(${lo} - e.gps_lon)), 2))`;

// Written manual photos whose file holds a mirror once the rows are right.
const REWRITE = `deleted_at IS NULL AND gps_source = 'manual' AND media_type = 'photo'
  AND gps_write_status IN ('ready', 'error') AND (gps_lat < 0 OR gps_lon < 0)`;

/** Every placed group, judged against the evidence of its hours. */
export async function findMirrored(): Promise<MirrorGroup[]> {
  const rows = await tx(async (client) => {
    // One pass over the placed rows, one bounded evidence scan per group on
    // the captured_at index; JIT off, the rule for a whole-library read.
    await client.query("SET LOCAL jit = off");
    const r = await client.query<Row>(
      `WITH grp AS (
         SELECT a.session_id,
                round(a.gps_lat::numeric, 5)::float8 AS lat,
                round(a.gps_lon::numeric, 5)::float8 AS lon,
                count(*)::int AS n,
                count(*) FILTER (WHERE a.gps_source = 'manual')::int AS manual,
                min(a.captured_at) AS t0, max(a.captured_at) AS t1,
                array_agg(a.id) AS ids,
                array_agg(DISTINCT date_trunc('day', a.captured_at)) AS days
           FROM assets a
          WHERE a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
            AND a.gps_source IN ('manual', 'inferred')
            AND a.captured_at IS NOT NULL
          GROUP BY 1, 2, 3
       )
       SELECT g.session_id, s.name AS folder, g.lat, g.lon, g.n, g.manual,
              g.t0, g.t1, g.ids, ev.n_ev, ev.d0, ev.d_lat, ev.d_lon, ev.d_both
         FROM grp g
         JOIN sessions s ON s.id = g.session_id
         CROSS JOIN LATERAL (
           -- Around each DAY the group was shot, not across its whole span:
           -- a container folder placed at one point can run for months, and
           -- one window from its first frame to its last scanned every fix
           -- in between (27 s for 400 such groups; per day, bounded).
           SELECT count(DISTINCT e.id)::int AS n_ev,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${dist("g.lat", "g.lon")}) AS d0,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${dist("-g.lat", "g.lon")}) AS d_lat,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${dist("g.lat", "-g.lon")}) AS d_lon,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${dist("-g.lat", "-g.lon")}) AS d_both
             FROM unnest(g.days) AS d(day)
             -- One captured_at index range per day. A plain join, or a LATERAL
             -- the planner flattens, scanned the whole table per group instead
             -- (past the 30 s statement timeout on 400 groups).
             CROSS JOIN LATERAL (
               SELECT x.id, x.gps_lat, x.gps_lon FROM assets x
                WHERE x.captured_at BETWEEN d.day - make_interval(hours => $1)
                                        AND d.day + make_interval(hours => 24 + $1)
                  AND x.deleted_at IS NULL AND x.gps_lat IS NOT NULL
                  AND (x.gps_source IS NULL OR x.gps_source = 'track')
               OFFSET 0  -- a fence: flattened, the scan went back to the table
             ) e
         ) ev
        ORDER BY g.t0`,
      [WINDOW_H],
    );
    return r.rows;
  });

  return rows.map((r) => {
    const flips = [
      { d: r.d_lat, to: { lat: -r.lat, lon: r.lon } },
      { d: r.d_lon, to: { lat: r.lat, lon: -r.lon } },
      { d: r.d_both, to: { lat: -r.lat, lon: -r.lon } },
    ]
      // A flip that changes nothing (a zero coordinate) is not a candidate.
      .filter((f) => f.d != null && (f.to.lat !== r.lat || f.to.lon !== r.lon))
      .sort((a, b) => a.d! - b.d!);
    const best = flips[0];
    let verdict: MirrorVerdict;
    if (r.n_ev === 0 || r.d0 == null) verdict = "no_evidence";
    else if (best && best.d! <= NEAR_KM && r.d0 >= RATIO * best.d! + MARGIN_KM)
      verdict = "mirrored";
    else if (r.d0 <= NEAR_KM) verdict = "ok";
    else verdict = "unclear";
    return {
      sessionId: Number(r.session_id),
      folder: r.folder,
      media: r.n,
      manual: r.manual,
      from: { lat: r.lat, lon: r.lon },
      to: verdict === "mirrored" ? best.to : null,
      storedKm: r.d0 == null ? null : Math.round(r.d0),
      flippedKm: verdict === "mirrored" ? Math.round(best.d!) : null,
      evidence: r.n_ev,
      verdict,
      t0: r.t0,
      t1: r.t1,
      // carried for apply, stripped from the report below
      ids: r.ids.map(Number),
    } as MirrorGroup & { ids: number[] };
  });
}

/**
 * Preview (apply=false) or apply the repair. Returns the groups that are not
 * plainly fine, and the counts. Never throws half-way through a write: the
 * corrections land in one transaction, the queues are fed after it commits.
 */
export async function repairMirrored(
  apply: boolean,
  deps?: MirrorDeps,
): Promise<MirrorReport> {
  const groups = (await findMirrored()) as (MirrorGroup & { ids: number[] })[];
  const mirrored = groups.filter((g) => g.verdict === "mirrored");

  const fixIds = mirrored.flatMap((g) => g.ids);
  let filesToRewrite: number;

  if (apply) {
    const rewrite = await tx(async (client) => {
      for (const g of mirrored) {
        // Each row's own coordinate, sign-flipped — not the group's point,
        // which is rounded to 5 decimals for grouping.
        const latSign = Math.sign(g.to!.lat) === Math.sign(g.from.lat) ? 1 : -1;
        const lonSign = Math.sign(g.to!.lon) === Math.sign(g.from.lon) ? 1 : -1;
        await client.query(
          `UPDATE assets SET gps = jsonb_build_object('lat', $2 * gps_lat, 'lon', $3 * gps_lon),
                  place_id = NULL, place_country = NULL, place_region = NULL,
                  place_county = NULL, place_city = NULL, place_poi = NULL,
                  geocode_status = 'pending', geocode_error = NULL, updated_at = now()
            WHERE id = ANY($1)`,
          [g.ids, latSign, lonSign],
        );
      }
      // After the correction, a written manual photo West or South holds a
      // mirror in its file, whichever way it got there.
      const w = await client.query<{ id: string }>(
        `UPDATE assets SET gps_write_status = 'pending', gps_write_error = NULL, updated_at = now()
          WHERE ${REWRITE}
          RETURNING id`,
      );
      if (fixIds.length) await applyOwnZones(fixIds, client);
      return w.rows.map((r) => Number(r.id));
    });
    const d = deps ?? (await import("./queue"));
    if (rewrite.length) await d.enqueueGpsWriteBulk(rewrite);
    if (fixIds.length) await d.enqueueGeocodeBulk(fixIds);
    filesToRewrite = rewrite.length;
  } else {
    // The same predicate, evaluated as if the corrections were made: a flipped
    // manual photo that was written, plus the ones already West or South.
    const r = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM assets
        WHERE deleted_at IS NULL AND gps_source = 'manual' AND media_type = 'photo'
          AND gps_write_status IN ('ready', 'error')
          AND (id = ANY($1) OR gps_lat < 0 OR gps_lon < 0)`,
      [fixIds],
    );
    filesToRewrite = r?.n ?? 0;
  }

  const count = (v: MirrorVerdict) =>
    groups.filter((g) => g.verdict === v).reduce((s, g) => s + g.media, 0);
  return {
    apply,
    groups: groups
      .filter((g) => g.verdict !== "ok")
      .map(({ ids: _ids, ...g }) => g),
    mirrored: count("mirrored"),
    filesToRewrite,
    unclear: count("unclear"),
    noEvidence: count("no_evidence"),
    ok: count("ok"),
  };
}
