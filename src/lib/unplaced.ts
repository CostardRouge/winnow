// The Unplaced view's read (docs/UNPLACED.md): the Incoming folders that still
// hold media with no position, merged into folder groups, each with a
// suggested position drawn from the located frames shot in the same hours.
// Server half — the vocabulary and the rules live in unplacedTypes.ts.
//
// Two scans, both under `SET LOCAL jit = off` (docs/memory/database.md):
//   1. one row per Incoming folder with something left to place — its capture
//      window and four tallies, each a LATERAL over that folder's index slice
//      (the sessions route's own pattern);
//   2. the donors, for every group at once: the group windows go in as three
//      parallel arrays (unnest), and the located frames inside them come back
//      aggregated per (group, geocoding cell) — count, median point, the body
//      that shot most of them, the cell's name. JS picks the dominant cell.
//      Groups that find nothing within ±near_h are asked again at ±day_h.
//
// The donors are the TRUSTWORTHY located frames only — gps_source NULL (a
// camera fix) or 'manual' (a pin placed by hand). An 'inferred' position never
// seeds another inference: a guess confirmed in bulk must not become the
// evidence for the next guess, or the backlog would fill itself with copies of
// one iPhone frame.
import { tx } from "./db";
import {
  UNPLACED_RULES,
  groupSessions,
  suggestionConfidence,
  type UnplacedGroup,
  type UnplacedResponse,
  type UnplacedSample,
  type UnplacedSession,
  type UnplacedSuggestion,
} from "./unplacedTypes";

type SessionRow = Omit<UnplacedSession, "sample"> & { sample: UnplacedSample[] | null };

type DonorRow = {
  idx: number;
  place_id: number | null;
  n: number;
  lat: number;
  lon: number;
  donor_model: string | null;
  city: string | null;
  country: string | null;
  display_name: string | null;
};

// "Pérols, France", the provider's label failing a city, null when the cell
// was never geocoded.
function cellName(r: DonorRow): string | null {
  if (r.city) return r.country ? `${r.city}, ${r.country}` : r.city;
  return r.display_name;
}

export async function listUnplaced(): Promise<UnplacedResponse> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");

    // 1. Folders with something left to place. Incoming only (docs/UNPLACED.md
    //    §4.1), ignored folders out, and a folder needs a capture window to be
    //    grouped at all — one without dates has nothing to say about time.
    const { rows: sessions } = await client.query<SessionRow>(
      `SELECT s.id, s.name, s.device_hint, s.captured_at_min, s.captured_at_max,
              d.total::int  AS total,
              d.unplaced::int AS unplaced,
              d.exempt::int AS exempt,
              d.no_exif::int AS no_exif,
              samp.sample
       FROM sessions s
       JOIN roots rt ON rt.id = s.root_id
       JOIN LATERAL (
         SELECT count(*) AS total,
                count(*) FILTER (WHERE a.gps_lat IS NULL AND a.geo_exempt_at IS NULL) AS unplaced,
                count(*) FILTER (WHERE a.geo_exempt_at IS NOT NULL) AS exempt,
                count(*) FILTER (WHERE a.gps_lat IS NULL AND a.geo_exempt_at IS NULL
                                   AND a.camera_model IS NULL AND a.lens IS NULL) AS no_exif
         FROM assets a
         WHERE a.session_id = s.id AND a.deleted_at IS NULL
       ) d ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('id', x.id, 'ext', x.ext, 'media_type', x.media_type)) AS sample
         FROM (
           SELECT a.id, a.ext, a.media_type
           FROM assets a
           WHERE a.session_id = s.id AND a.deleted_at IS NULL
             AND a.derivative_status = 'ready'
           ORDER BY a.captured_at ASC NULLS LAST, a.id ASC
           LIMIT 6
         ) x
       ) samp ON true
       WHERE rt.kind <> 'finals' AND s.ignored = false
         AND s.captured_at_min IS NOT NULL
         AND d.unplaced > 0
       ORDER BY s.captured_at_min ASC, s.id ASC`,
    );

    const members = groupSessions(sessions, UNPLACED_RULES.gap_h * 3_600_000);
    // The window bounds are compared as instants, not as strings: pg hands
    // timestamptz over verbatim (lib/db.ts), in the session's zone, and a
    // lexicographic min/max would misorder two folders straddling a DST shift.
    const groups: UnplacedGroup[] = members.map((ss) => {
      const t0 = ss.reduce(
        (m, s) => (Date.parse(s.captured_at_min) < Date.parse(m) ? s.captured_at_min : m),
        ss[0].captured_at_min,
      );
      const t1 = ss.reduce((m, s) => {
        const e = s.captured_at_max ?? s.captured_at_min;
        return Date.parse(e) > Date.parse(m) ? e : m;
      }, ss[0].captured_at_max ?? ss[0].captured_at_min);
      const sample: UnplacedSample[] = [];
      for (const s of ss) for (const x of s.sample ?? []) if (sample.length < 6) sample.push(x);
      return {
        key: ss.map((s) => s.id).join("-"),
        sessions: ss.map((s) => ({ ...s, sample: s.sample ?? [] })),
        t0,
        t1,
        total: ss.reduce((n, s) => n + s.total, 0),
        unplaced: ss.reduce((n, s) => n + s.unplaced, 0),
        exempt: ss.reduce((n, s) => n + s.exempt, 0),
        no_exif: ss.reduce((n, s) => n + s.no_exif, 0),
        sample,
        suggestion: null,
      };
    });

    // 2. Donors, in one pass per window size.
    const donors = async (idxs: number[], pad: string): Promise<DonorRow[]> => {
      if (!idxs.length) return [];
      const { rows } = await client.query<DonorRow>(
        `WITH win AS (
           SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[]) AS w(idx, t0, t1)
         ),
         hits AS (
           SELECT w.idx, a.place_id, a.gps_lat, a.gps_lon, a.camera_model
           FROM win w
           JOIN assets a
             ON a.captured_at >= w.t0 - $4::interval
            AND a.captured_at <= w.t1 + $4::interval
           WHERE a.deleted_at IS NULL
             AND a.gps_lat IS NOT NULL
             -- trustworthy only: never let an inferred position seed the next
             AND (a.gps_source IS NULL OR a.gps_source = 'manual')
         )
         SELECT h.idx, h.place_id,
                count(*)::int AS n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY h.gps_lat) AS lat,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY h.gps_lon) AS lon,
                mode() WITHIN GROUP (ORDER BY h.camera_model) AS donor_model,
                p.city, p.country, p.display_name
         FROM hits h
         LEFT JOIN places p ON p.id = h.place_id
         GROUP BY h.idx, h.place_id, p.city, p.country, p.display_name
         ORDER BY h.idx, n DESC`,
        [
          idxs,
          idxs.map((i) => groups[i].t0),
          idxs.map((i) => groups[i].t1),
          pad,
        ],
      );
      return rows;
    };

    const apply = (rows: DonorRow[], window: "near" | "day") => {
      // Rows arrive ordered by idx then n DESC: the first row of an idx is its
      // dominant cell.
      const byIdx = new Map<number, DonorRow[]>();
      for (const r of rows) {
        const list = byIdx.get(r.idx);
        if (list) list.push(r);
        else byIdx.set(r.idx, [r]);
      }
      for (const [idx, list] of byIdx) {
        const located = list.reduce((n, r) => n + r.n, 0);
        const dom = list[0];
        const share = located ? dom.n / located : 0;
        const suggestion: UnplacedSuggestion = {
          lat: Number(dom.lat),
          lon: Number(dom.lon),
          name: cellName(dom),
          located,
          share,
          confidence: suggestionConfidence(located, share),
          window,
          donor_model: dom.donor_model,
        };
        groups[idx].suggestion = suggestion;
      }
    };

    const all = groups.map((_, i) => i);
    apply(await donors(all, `${UNPLACED_RULES.near_h} hours`), "near");
    const missing = all.filter((i) => groups[i].suggestion == null);
    apply(await donors(missing, `${UNPLACED_RULES.day_h} hours`), "day");

    // Biggest piles first: the backlog is worked from the top.
    groups.sort((a, b) => b.unplaced - a.unplaced || a.t0.localeCompare(b.t0));

    return {
      groups,
      totals: {
        groups: groups.length,
        unplaced: groups.reduce((n, g) => n + g.unplaced, 0),
        no_exif: groups.reduce((n, g) => n + g.no_exif, 0),
      },
      rules: UNPLACED_RULES,
    };
  });
}
