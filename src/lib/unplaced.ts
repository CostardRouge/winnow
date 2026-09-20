// The Unplaced view's read (docs/UNPLACED.md): the Incoming folders that still
// hold media with no position, merged into folder groups, each with a
// suggested position drawn from the located frames shot in the same hours.
// Server half — the vocabulary and the rules live in unplacedTypes.ts.
//
// Four scans, all under `SET LOCAL jit = off` (docs/memory/database.md):
//   1. the whole Incoming library's placed / unplaced / exempt tallies — the
//      progress bar, one pass over the live rows;
//   2. one row per Incoming folder with something left to place — its capture
//      window and four tallies, each a LATERAL over that folder's index slice
//      (the sessions route's own pattern). groupSessions() then sorts them
//      into SHOOTS (short folders, merged by time) and SPANS (containers: a
//      month, a year);
//   3. the parts of every span at once: its unplaced camera media, in capture
//      order, cut at every gap_h silence (gaps-and-islands: a LAG, a running
//      SUM of the cuts). A container under parts_max parts becomes one card
//      per part, plus one span card for what lies outside every part — media
//      with no camera EXIF, which the cut never looks at, or no capture time;
//      one over it stays a single span card, too scattered for a list;
//   4. the donors, for every shoot and part at once: the windows go in as
//      three parallel arrays (unnest), and the located frames inside them come
//      back aggregated per (card, geocoding cell) — count, median point, the
//      body that shot most of them, the cell's name. JS picks the dominant
//      cell. Cards that find nothing within ±near_h are asked again at
//      ±day_h. Spans are never asked: a month of located frames points at a
//      month of places.
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
  groupTier,
  isReady,
  suggestionConfidence,
  type UnplacedGroup,
  type UnplacedResponse,
  type UnplacedSample,
  type UnplacedSession,
  type UnplacedSuggestion,
} from "./unplacedTypes";

type SessionRow = Omit<UnplacedSession, "sample"> & { sample: UnplacedSample[] | null };

// One part of a container folder, before its tallies.
type CutRow = { session_id: number; t0: string; t1: string };

type PartRow = {
  session_id: number;
  idx: number;
  total: number;
  unplaced: number;
  no_exif: number;
  sample: UnplacedSample[] | null;
};

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

// The Incoming scope, written once: not a finals root, not an ignored folder,
// a live row. Every scan below joins the same way.
const INCOMING_FROM = `
  FROM assets a
  JOIN sessions s  ON s.id  = a.session_id
  JOIN roots    rt ON rt.id = s.root_id`;
const INCOMING_WHERE = `rt.kind <> 'finals' AND s.ignored = false AND a.deleted_at IS NULL`;

// "No position, not exempted" — the backlog predicate, and the one
// assets_geo_todo_idx (0042) serves.
const TODO = `a.gps_lat IS NULL AND a.geo_exempt_at IS NULL`;
// The census's discriminator for screenshots and scans (docs/UNPLACED.md §2).
const NO_EXIF = `a.camera_model IS NULL AND a.lens IS NULL`;

const H = 3_600_000;

// The window bounds are compared as instants, not as strings: pg hands
// timestamptz over verbatim (lib/db.ts), in the session's zone, and a
// lexicographic min/max would misorder two folders straddling a DST shift.
function windowOf(ss: UnplacedSession[]): { t0: string; t1: string } {
  const t0 = ss.reduce(
    (m, s) => (Date.parse(s.captured_at_min) < Date.parse(m) ? s.captured_at_min : m),
    ss[0].captured_at_min,
  );
  const t1 = ss.reduce((m, s) => {
    const e = s.captured_at_max ?? s.captured_at_min;
    return Date.parse(e) > Date.parse(m) ? e : m;
  }, ss[0].captured_at_max ?? ss[0].captured_at_min);
  return { t0, t1 };
}

export async function listUnplaced(): Promise<UnplacedResponse> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");

    // 1. The library-wide tallies the progress bar draws.
    const { rows: [tally] } = await client.query<{
      placed: number;
      unplaced: number;
      exempt: number;
    }>(
      `SELECT count(*) FILTER (WHERE a.gps_lat IS NOT NULL)::int AS placed,
              count(*) FILTER (WHERE ${TODO})::int AS unplaced,
              count(*) FILTER (WHERE a.geo_exempt_at IS NOT NULL)::int AS exempt
       ${INCOMING_FROM}
       WHERE ${INCOMING_WHERE}`,
    );

    // 2. Folders with something left to place (docs/UNPLACED.md §4.1). A
    //    folder needs a capture window to be grouped at all — one without
    //    dates has nothing to say about time.
    const { rows: sessionRows } = await client.query<SessionRow>(
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
                count(*) FILTER (WHERE ${TODO}) AS unplaced,
                count(*) FILTER (WHERE a.geo_exempt_at IS NOT NULL) AS exempt,
                count(*) FILTER (WHERE ${TODO} AND ${NO_EXIF}) AS no_exif
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
    const sessions: UnplacedSession[] = sessionRows.map((s) => ({
      ...s,
      sample: s.sample ?? [],
    }));

    const families = groupSessions(
      sessions,
      UNPLACED_RULES.gap_h * H,
      UNPLACED_RULES.span_max_h * H,
    );

    // 3. Cut every container at once. Only its unplaced media WITH camera
    //    EXIF take part in the cut: screenshots and scans are spread over the
    //    month by nature, and a card per screenshot is the noise this view
    //    exists to remove — they stay behind in the folder's span card, whose
    //    one verb is Exempt.
    const spanIds = families.flatMap((f) =>
      f.kind === "span" ? [f.members[0].id] : [],
    );
    const cutsBySession = new Map<number, CutRow[]>();
    if (spanIds.length) {
      const { rows: cuts } = await client.query<CutRow>(
        `WITH m AS (
           SELECT a.session_id, a.id, a.captured_at,
                  CASE WHEN a.captured_at - lag(a.captured_at) OVER w > $2::interval
                       THEN 1 ELSE 0 END AS cut
           FROM assets a
           WHERE a.session_id = ANY($1::int[]) AND a.deleted_at IS NULL
             AND ${TODO} AND NOT (${NO_EXIF})
             AND a.captured_at IS NOT NULL
           WINDOW w AS (PARTITION BY a.session_id ORDER BY a.captured_at, a.id)
         ),
         numbered AS (
           SELECT session_id, captured_at,
                  sum(cut) OVER (PARTITION BY session_id ORDER BY captured_at, id
                                 ROWS UNBOUNDED PRECEDING) AS part
           FROM m
         )
         SELECT session_id, min(captured_at) AS t0, max(captured_at) AS t1
         FROM numbered
         GROUP BY session_id, part
         ORDER BY session_id, t0`,
        [spanIds, `${UNPLACED_RULES.gap_h} hours`],
      );
      for (const c of cuts) {
        const list = cutsBySession.get(c.session_id);
        if (list) list.push(c);
        else cutsBySession.set(c.session_id, [c]);
      }
    }

    //    Then the tallies and a sample for each part of the containers under
    //    the cap — the same LATERAL as scan 2, over the part's window.
    const cuttable = [...cutsBySession].filter(
      ([, cuts]) => cuts.length <= UNPLACED_RULES.parts_max,
    );
    const flat = cuttable.flatMap(([sid, cuts]) =>
      cuts.map((c, i) => ({ sid, idx: i + 1, t0: c.t0, t1: c.t1 })),
    );
    const partsBySession = new Map<number, PartRow[]>();
    if (flat.length) {
      const { rows: parts } = await client.query<PartRow>(
        `SELECT w.sid AS session_id, w.idx,
                d.total::int AS total, d.unplaced::int AS unplaced, d.no_exif::int AS no_exif,
                samp.sample
         FROM unnest($1::int[], $2::int[], $3::timestamptz[], $4::timestamptz[])
              AS w(sid, idx, t0, t1)
         JOIN LATERAL (
           SELECT count(*) AS total,
                  count(*) FILTER (WHERE ${TODO}) AS unplaced,
                  count(*) FILTER (WHERE ${TODO} AND ${NO_EXIF}) AS no_exif
           FROM assets a
           WHERE a.session_id = w.sid AND a.deleted_at IS NULL
             AND a.captured_at >= w.t0 AND a.captured_at <= w.t1
         ) d ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object('id', x.id, 'ext', x.ext, 'media_type', x.media_type)) AS sample
           FROM (
             SELECT a.id, a.ext, a.media_type
             FROM assets a
             WHERE a.session_id = w.sid AND a.deleted_at IS NULL
               AND a.captured_at >= w.t0 AND a.captured_at <= w.t1
               AND a.derivative_status = 'ready'
             ORDER BY a.captured_at ASC, a.id ASC
             LIMIT 6
           ) x
         ) samp ON true
         ORDER BY w.sid, w.idx`,
        [
          flat.map((p) => p.sid),
          flat.map((p) => p.idx),
          flat.map((p) => p.t0),
          flat.map((p) => p.t1),
        ],
      );
      for (const p of parts) {
        const list = partsBySession.get(p.session_id);
        if (list) list.push(p);
        else partsBySession.set(p.session_id, [p]);
      }
    }

    const groups: UnplacedGroup[] = [];
    for (const f of families) {
      const ss = f.members;
      if (f.kind === "shoot") {
        const sample: UnplacedSample[] = [];
        for (const s of ss) for (const x of s.sample) if (sample.length < 6) sample.push(x);
        groups.push({
          key: ss.map((s) => s.id).join("-"),
          kind: "shoot",
          sessions: ss,
          ...windowOf(ss),
          total: ss.reduce((n, s) => n + s.total, 0),
          unplaced: ss.reduce((n, s) => n + s.unplaced, 0),
          exempt: ss.reduce((n, s) => n + s.exempt, 0),
          no_exif: ss.reduce((n, s) => n + s.no_exif, 0),
          sample,
          suggestion: null,
          part: null,
          moments: null,
        });
        continue;
      }
      const s = ss[0];
      const cuts = cutsBySession.get(s.id) ?? [];
      const parts = partsBySession.get(s.id) ?? [];
      const flatOf = flat.filter((p) => p.sid === s.id);
      for (const p of parts) {
        const w = flatOf[p.idx - 1];
        groups.push({
          key: `${s.id}:${p.idx}`,
          kind: "part",
          sessions: [s],
          t0: w.t0,
          t1: w.t1,
          total: p.total,
          unplaced: p.unplaced,
          exempt: 0,
          no_exif: p.no_exif,
          sample: p.sample ?? [],
          suggestion: null,
          part: { index: p.idx, count: parts.length },
          moments: null,
        });
      }
      // What the parts do not cover — all of it when the folder was not cut.
      // Each unplaced media of the folder is on exactly one card.
      const inParts = parts.reduce((n, p) => n + p.unplaced, 0);
      const rest = s.unplaced - inParts;
      if (rest > 0) {
        groups.push({
          key: String(s.id),
          kind: "span",
          sessions: [s],
          ...windowOf([s]),
          total: s.total,
          unplaced: rest,
          exempt: s.exempt,
          no_exif: Math.max(0, s.no_exif - parts.reduce((n, p) => n + p.no_exif, 0)),
          sample: s.sample,
          suggestion: null,
          part: null,
          moments: cuts.length > UNPLACED_RULES.parts_max ? cuts.length : null,
        });
      }
    }

    // 4. Donors, in one pass per window size, for every shoot and part.
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

    const askable = groups.flatMap((g, i) => (g.kind !== "span" ? [i] : []));
    apply(await donors(askable, `${UNPLACED_RULES.near_h} hours`), "near");
    const missing = askable.filter((i) => groups[i].suggestion == null);
    apply(await donors(missing, `${UNPLACED_RULES.day_h} hours`), "day");

    // Worked from the top: the confident suggestions first, the biggest pile
    // first within a tier, the spans last.
    groups.sort(
      (a, b) =>
        groupTier(a) - groupTier(b) ||
        b.unplaced - a.unplaced ||
        Date.parse(a.t0) - Date.parse(b.t0),
    );

    const ready = groups.filter(isReady).length;
    return {
      groups,
      totals: {
        groups: groups.length,
        placed: Number(tally?.placed ?? 0),
        unplaced: Number(tally?.unplaced ?? 0),
        exempt: Number(tally?.exempt ?? 0),
        no_exif: groups.reduce((n, g) => n + g.no_exif, 0),
        ready,
        by_hand: groups.length - ready,
      },
      rules: UNPLACED_RULES,
    };
  });
}
