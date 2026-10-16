// The Unplaced view's read (docs/UNPLACED.md): the Incoming folders that still
// hold media with no position, one card per folder (or per part of a
// container folder), each with a suggested position drawn from the located
// frames shot in the same hours, and the folders shot alongside it.
// Server half — the vocabulary and the rules live in unplacedTypes.ts.
//
// Some unplaced media are on NO card (§12): screenshots, files saved from
// another app, graded exports — lib/unplacedSql.ts names them, and every card
// scan below reads TODO_CARD, the backlog without them. A time-based
// suggestion can only get those wrong; they have their own dialogs, and only
// their counts ride along here (totals.aside).
//
// Four scans, all under `SET LOCAL jit = off` (docs/memory/database.md):
//   1. the whole Incoming library's placed / unplaced / exempt tallies — the
//      progress bar, one pass over the live rows;
//   2. one row per Incoming folder with something left to place — its capture
//      window and four tallies, each a LATERAL over that folder's index slice
//      (the sessions route's own pattern). splitSessions() then sorts them
//      into SHOOTS (short folders, one card each — never merged, §9.8) and
//      SPANS (containers: a month, a year);
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
//      month of places;
//   5. the place split, for the cards whose near donors spread past
//      split_km only: their donors one by one, then their own media's capture times,
//      then the tallies of each place's window — see the step itself.
//
// Beside it, placesNear(): the positions a human already applied around a
// card's dates, for the Place dialog to offer as one-click choices.
// The donors are the TRUSTWORTHY located frames only — gps_source NULL (a
// camera fix) or 'manual' (a pin placed by hand). An 'inferred' position never
// seeds another inference: a guess confirmed in bulk must not become the
// evidence for the next guess, or the backlog would fill itself with copies of
// one iPhone frame.
import type { PoolClient } from "pg";
import { tx } from "./db";
import { gradedExports } from "./unplacedAside";
import {
  ASIDE,
  GRADED,
  INCOMING_FROM,
  INCOMING_WHERE,
  NO_EXIF,
  SAVED,
  SCREENSHOT,
  TODO,
  TODO_CARD,
} from "./unplacedSql";
import {
  UNPLACED_RULES,
  betterConfidence,
  bracketEvidence,
  distanceM,
  impossibleLeg,
  isReady,
  placeCuts,
  placeRuns,
  runSuggestion,
  siblingsWithin,
  sortGroups,
  splitSessions,
  suggestionConfidence,
  type EvidenceFix,
  type PlaceRun,
  type UnplacedDonor,
  type UnplacedGroup,
  type UnplacedPlace,
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
  exempt: number;
  no_exif: number;
  first: string | null;
  last: string | null;
  sample: UnplacedSample[] | null;
};

// A time window into one folder: a part of a container, or a place of a card.
type WindowSpec = { sid: number; idx: number; t0: string; t1: string };

// The tallies and a sample for each window at once — scan 2's LATERAL, over
// the window. `idx` comes back as given, so the caller keys the rows.
async function tallyWindows(client: PoolClient, ws: WindowSpec[]): Promise<PartRow[]> {
  if (!ws.length) return [];
  const { rows } = await client.query<PartRow>(
    `SELECT w.sid AS session_id, w.idx,
            d.total::int AS total, d.unplaced::int AS unplaced,
            d.exempt::int AS exempt, d.no_exif::int AS no_exif,
            d.first, d.last,
            samp.sample
     FROM unnest($1::int[], $2::int[], $3::timestamptz[], $4::timestamptz[])
          AS w(sid, idx, t0, t1)
     JOIN LATERAL (
       SELECT count(*) AS total,
              count(*) FILTER (WHERE ${TODO_CARD}) AS unplaced,
              count(*) FILTER (WHERE a.geo_exempt_at IS NOT NULL) AS exempt,
              count(*) FILTER (WHERE ${TODO_CARD} AND ${NO_EXIF}) AS no_exif,
              min(a.captured_at) FILTER (WHERE ${TODO_CARD}) AS first,
              max(a.captured_at) FILTER (WHERE ${TODO_CARD}) AS last
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
           AND a.derivative_status = 'ready' AND NOT ${ASIDE}
         ORDER BY a.captured_at ASC, a.id ASC
         LIMIT 6
       ) x
     ) samp ON true
     ORDER BY w.sid, w.idx`,
    [ws.map((w) => w.sid), ws.map((w) => w.idx), ws.map((w) => w.t0), ws.map((w) => w.t1)],
  );
  return rows;
}

type RawDonorRow = {
  idx: number;
  at: string;
  lat: number;
  lon: number;
  place_id: number | null;
  camera_model: string | null;
  city: string | null;
  country: string | null;
  display_name: string | null;
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
  /** The cell's donors' bounding box — how far a card's donors spread,
   *  whether or not they were geocoded yet (step 5's precondition). */
  lat_min: number;
  lat_max: number;
  lon_min: number;
  lon_max: number;
};

// "Pérols, France", the provider's label failing a city, null when the cell
// was never geocoded.
function cellName(r: Pick<DonorRow, "city" | "country" | "display_name">): string | null {
  if (r.city) return r.country ? `${r.city}, ${r.country}` : r.city;
  return r.display_name;
}

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
      graded: number;
      screenshots: number;
      saved: number;
    }>(
      `SELECT count(*) FILTER (WHERE a.gps_lat IS NOT NULL)::int AS placed,
              count(*) FILTER (WHERE ${TODO})::int AS unplaced,
              count(*) FILTER (WHERE a.geo_exempt_at IS NOT NULL)::int AS exempt,
              count(*) FILTER (WHERE ${TODO} AND ${GRADED})::int AS graded,
              count(*) FILTER (WHERE ${TODO} AND NOT ${GRADED} AND ${SCREENSHOT})::int AS screenshots,
              count(*) FILTER (WHERE ${TODO} AND NOT ${GRADED} AND NOT ${SCREENSHOT} AND ${SAVED})::int AS saved
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
                count(*) FILTER (WHERE ${TODO_CARD}) AS unplaced,
                count(*) FILTER (WHERE a.geo_exempt_at IS NOT NULL) AS exempt,
                count(*) FILTER (WHERE ${TODO_CARD} AND ${NO_EXIF}) AS no_exif
         FROM assets a
         WHERE a.session_id = s.id AND a.deleted_at IS NULL
       ) d ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('id', x.id, 'ext', x.ext, 'media_type', x.media_type)) AS sample
         FROM (
           SELECT a.id, a.ext, a.media_type
           FROM assets a
           WHERE a.session_id = s.id AND a.deleted_at IS NULL
             AND a.derivative_status = 'ready' AND NOT ${ASIDE}
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

    const families = splitSessions(sessions, UNPLACED_RULES.span_max_h * H);
    const shootRows = families.flatMap((f) => (f.kind === "shoot" ? [f.row] : []));
    // The folders shot alongside a window, in the shape the dialog lists.
    const siblingsOf = (w: { t0: string; t1: string }, exceptId: number) =>
      siblingsWithin(w, shootRows, UNPLACED_RULES.gap_h * H, exceptId).map((x) => ({
        id: x.id,
        name: x.name,
        device_hint: x.device_hint,
        captured_at_min: x.captured_at_min,
        captured_at_max: x.captured_at_max,
        total: x.total,
        unplaced: x.unplaced,
      }));

    // 3. Cut every container at once. Only its unplaced media WITH camera
    //    EXIF take part in the cut: screenshots and scans are spread over the
    //    month by nature, and a card per screenshot is the noise this view
    //    exists to remove — they stay behind in the folder's span card, whose
    //    one verb is Exempt.
    const spanIds = families.flatMap((f) => (f.kind === "span" ? [f.row.id] : []));
    const cutsBySession = new Map<number, CutRow[]>();
    if (spanIds.length) {
      const { rows: cuts } = await client.query<CutRow>(
        `WITH m AS (
           SELECT a.session_id, a.id, a.captured_at,
                  CASE WHEN a.captured_at - lag(a.captured_at) OVER w > $2::interval
                       THEN 1 ELSE 0 END AS cut
           FROM assets a
           WHERE a.session_id = ANY($1::int[]) AND a.deleted_at IS NULL
             AND ${TODO_CARD} AND NOT (${NO_EXIF})
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
    for (const p of await tallyWindows(client, flat)) {
      const list = partsBySession.get(p.session_id);
      if (list) list.push(p);
      else partsBySession.set(p.session_id, [p]);
    }

    const groups: UnplacedGroup[] = [];
    for (const f of families) {
      if (f.kind === "shoot") {
        const s = f.row;
        const w = windowOf([s]);
        groups.push({
          key: String(s.id),
          kind: "shoot",
          sessions: [s],
          siblings: siblingsOf(w, s.id),
          ...w,
          total: s.total,
          unplaced: s.unplaced,
          exempt: s.exempt,
          no_exif: s.no_exif,
          sample: s.sample,
          suggestion: null,
          part: null,
          stops: null,
          conflict: null,
          nearest: null,
          moments: null,
        });
        continue;
      }
      const s = f.row;
      const cuts = cutsBySession.get(s.id) ?? [];
      const parts = partsBySession.get(s.id) ?? [];
      const flatOf = flat.filter((p) => p.sid === s.id);
      for (const p of parts) {
        const w = flatOf[p.idx - 1];
        groups.push({
          key: `${s.id}:${p.idx}`,
          kind: "part",
          sessions: [s],
          siblings: siblingsOf(w, s.id),
          t0: w.t0,
          t1: w.t1,
          total: p.total,
          unplaced: p.unplaced,
          exempt: p.exempt,
          no_exif: p.no_exif,
          sample: p.sample ?? [],
          suggestion: null,
          part: { index: p.idx, count: parts.length },
          stops: null,
          conflict: null,
          nearest: null,
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
          siblings: [],
          ...windowOf([s]),
          total: s.total,
          unplaced: rest,
          // The parts show their own exempt media; this card the rest, so
          // no exempt media is counted on two cards.
          exempt: Math.max(0, s.exempt - parts.reduce((n, p) => n + p.exempt, 0)),
          no_exif: Math.max(0, s.no_exif - parts.reduce((n, p) => n + p.no_exif, 0)),
          sample: s.sample,
          suggestion: null,
          part: null,
          stops: null,
          conflict: null,
          nearest: null,
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
             AND (a.gps_source IS NULL OR a.gps_source IN ('manual', 'track'))
         )
         SELECT h.idx, h.place_id,
                count(*)::int AS n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY h.gps_lat) AS lat,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY h.gps_lon) AS lon,
                mode() WITHIN GROUP (ORDER BY h.camera_model) AS donor_model,
                min(h.gps_lat) AS lat_min, max(h.gps_lat) AS lat_max,
                min(h.gps_lon) AS lon_min, max(h.gps_lon) AS lon_max,
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

    // How far a card's near donors spread (the diagonal of their bounding
    // box, metres): only a card whose donors spread past split_km can hold
    // two places, so only those are read again one frame at a time. Not the
    // cell count: a donor not geocoded yet has no cell, and thousands aren't.
    const spreadOf = new Map<number, number>();
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
          evidence: null,
        };
        groups[idx].suggestion = suggestion;
        if (window === "near") {
          spreadOf.set(
            idx,
            distanceM(
              {
                lat: Math.min(...list.map((r) => Number(r.lat_min))),
                lon: Math.min(...list.map((r) => Number(r.lon_min))),
              },
              {
                lat: Math.max(...list.map((r) => Number(r.lat_max))),
                lon: Math.max(...list.map((r) => Number(r.lon_max))),
              },
            ),
          );
        }
      }
    };

    const askable = groups.flatMap((g, i) => (g.kind !== "span" ? [i] : []));
    apply(await donors(askable, `${UNPLACED_RULES.near_h} hours`), "near");
    const missing = askable.filter((i) => groups[i].suggestion == null);
    apply(await donors(missing, `${UNPLACED_RULES.day_h} hours`), "day");

    // 4b. Confidence by distance (tight_km, docs/UNPLACED.md §12). The cell
    //     share above counts donors over two hours and splits them at cell
    //     boundaries: a clip shot 90 s between two Sony frames at the same
    //     spot read "low" because the hour around it held 394 frames over
    //     three cells. So, for every card the near window found donors for:
    //     the located frame just before it and the one just after (each
    //     within near_h — two walks down captured_at's index per card), and
    //     the box of the located frames inside its own hours. All within
    //     tight_km of each other: bracketed (high) or one-sided (medium),
    //     and the pin moves to the nearest of them in time. Applied only
    //     where it RAISES the confidence — evidence never lowers what the
    //     share said — and before step 5, whose conflict still overrides it.
    const nearIdx = askable.filter((i) => groups[i].suggestion?.window === "near");
    if (nearIdx.length) {
      const wins = [nearIdx, nearIdx.map((i) => groups[i].t0), nearIdx.map((i) => groups[i].t1)];
      const { rows: sides } = await client.query<{
        idx: number;
        side: "before" | "after";
        at: string;
        lat: number;
        lon: number;
        filename: string;
        model: string | null;
        city: string | null;
        country: string | null;
        display_name: string | null;
      }>(
        `SELECT w.idx, e.side, e.at, e.lat, e.lon, e.filename, e.model,
                p.city, p.country, p.display_name
         FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[]) AS w(idx, t0, t1)
         CROSS JOIN LATERAL (
           (SELECT 'before' AS side, a.captured_at AS at, a.gps_lat AS lat, a.gps_lon AS lon,
                   a.filename, a.camera_model AS model, a.place_id
              FROM assets a
             WHERE a.captured_at < w.t0 AND a.captured_at >= w.t0 - $4::interval
               AND a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
               AND (a.gps_source IS NULL OR a.gps_source IN ('manual', 'track'))
             ORDER BY a.captured_at DESC LIMIT 1)
           UNION ALL
           (SELECT 'after' AS side, a.captured_at AS at, a.gps_lat AS lat, a.gps_lon AS lon,
                   a.filename, a.camera_model AS model, a.place_id
              FROM assets a
             WHERE a.captured_at > w.t1 AND a.captured_at <= w.t1 + $4::interval
               AND a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
               AND (a.gps_source IS NULL OR a.gps_source IN ('manual', 'track'))
             ORDER BY a.captured_at ASC LIMIT 1)
         ) e
         LEFT JOIN places p ON p.id = e.place_id`,
        [...wins, `${UNPLACED_RULES.near_h} hours`],
      );
      const { rows: inside } = await client.query<{
        idx: number;
        n: number;
        lat_min: number;
        lat_max: number;
        lon_min: number;
        lon_max: number;
      }>(
        `SELECT w.idx, count(*)::int AS n,
                min(a.gps_lat) AS lat_min, max(a.gps_lat) AS lat_max,
                min(a.gps_lon) AS lon_min, max(a.gps_lon) AS lon_max
         FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[]) AS w(idx, t0, t1)
         JOIN assets a ON a.captured_at >= w.t0 AND a.captured_at <= w.t1
         WHERE a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
           AND (a.gps_source IS NULL OR a.gps_source IN ('manual', 'track'))
         GROUP BY w.idx`,
        wins,
      );
      const fixes = new Map<number, { before: EvidenceFix | null; after: EvidenceFix | null }>();
      for (const r of sides) {
        const f: EvidenceFix = {
          at: r.at,
          filename: r.filename,
          model: r.model,
          name: cellName(r),
          lat: Number(r.lat),
          lon: Number(r.lon),
        };
        const cur = fixes.get(r.idx) ?? { before: null, after: null };
        cur[r.side] = f;
        fixes.set(r.idx, cur);
      }
      const insideOf = new Map(inside.map((r) => [r.idx, r]));
      for (const idx of nearIdx) {
        const g = groups[idx];
        const s = g.suggestion!;
        const f = fixes.get(idx);
        const ins = insideOf.get(idx);
        const ev = bracketEvidence(
          Date.parse(g.t0),
          Date.parse(g.t1),
          f?.before ?? null,
          f?.after ?? null,
          ins
            ? {
                n: ins.n,
                lat_min: Number(ins.lat_min),
                lat_max: Number(ins.lat_max),
                lon_min: Number(ins.lon_min),
                lon_max: Number(ins.lon_max),
              }
            : null,
          UNPLACED_RULES.tight_km * 1000,
        );
        if (!ev || betterConfidence(ev.confidence, s.confidence) === s.confidence) continue;
        g.suggestion = {
          ...s,
          confidence: ev.confidence,
          evidence: ev.evidence,
          ...(ev.pin ? { lat: ev.pin.lat, lon: ev.pin.lon, name: ev.pin.name } : {}),
        };
      }
    }

    // 5. Cut by place. A card is one folder or one slice of one, and that is
    //    a unit of TIME: a day out that visits two towns is one shoot, and
    //    one suggestion — the dominant cell's median — put the second town's
    //    frames in the first (docs/UNPLACED.md §10). So a card whose near
    //    donors spread past split_km is read again, frame by frame: its
    //    located frames in time order make runs that stay within split_km
    //    (placeRuns), each run is a place, and the card's own media are cut
    //    between two places in the longest silence of the camera
    //    (placeCuts). Each place becomes a STOP of the card — a time window
    //    into it, with its own suggestion by the same rule as a whole card
    //    (runSuggestion) — and the card stays one card: the folder is one
    //    thing the maintainer opened (§11). Day-window donors never
    //    split a card: a frame from hours away says nothing about when the
    //    card moved.
    const mixed = askable.filter(
      (i) => (spreadOf.get(i) ?? 0) > UNPLACED_RULES.split_km * 1000,
    );
    if (mixed.length) {
      const pad = `${UNPLACED_RULES.near_h} hours`;
      const { rows: raw } = await client.query<RawDonorRow>(
        `SELECT w.idx, a.captured_at AS at, a.gps_lat AS lat, a.gps_lon AS lon,
                a.place_id, a.camera_model, p.city, p.country, p.display_name
         FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[]) AS w(idx, t0, t1)
         JOIN assets a
           ON a.captured_at >= w.t0 - $4::interval
          AND a.captured_at <= w.t1 + $4::interval
         LEFT JOIN places p ON p.id = a.place_id
         WHERE a.deleted_at IS NULL
           AND a.gps_lat IS NOT NULL
           AND (a.gps_source IS NULL OR a.gps_source IN ('manual', 'track'))
         ORDER BY w.idx, a.captured_at, a.id`,
        [
          mixed,
          mixed.map((i) => groups[i].t0),
          mixed.map((i) => groups[i].t1),
          pad,
        ],
      );
      const runsOf = new Map<number, PlaceRun[]>();
      const byIdx = new Map<number, UnplacedDonor[]>();
      for (const r of raw) {
        const d: UnplacedDonor = {
          at: Date.parse(r.at),
          lat: Number(r.lat),
          lon: Number(r.lon),
          cell: r.place_id,
          name: cellName(r),
          model: r.camera_model,
        };
        const list = byIdx.get(r.idx);
        if (list) list.push(d);
        else byIdx.set(r.idx, [d]);
      }
      for (const [idx, list] of byIdx) {
        const runs = placeRuns(
          list,
          UNPLACED_RULES.split_km * 1000,
          UNPLACED_RULES.split_min,
        );
        if (runs.length < 2) continue;
        // Two places no one could travel between in the time: the located
        // frames disagree (a wrong clock or zone on one side). No stops — a
        // cut between Porto and Melbourne two hours apart would place half
        // the card on the wrong continent — and no confident pin either.
        const leg = impossibleLeg(runs, UNPLACED_RULES.max_kmh);
        if (leg) {
          const g = groups[idx];
          const at = (r: PlaceRun) => {
            const s = runSuggestion(r.donors);
            return { name: s.name, lat: s.lat, lon: s.lon, model: s.donor_model };
          };
          g.conflict = {
            a: at(runs[leg.k]),
            b: at(runs[leg.k + 1]),
            km: Math.round(leg.km),
            hours: Math.round(leg.hours * 10) / 10,
          };
          // Nor the evidence of step 4b: two frames agreeing next to the card
          // say nothing once the frames around it disagree.
          if (g.suggestion) g.suggestion = { ...g.suggestion, confidence: "low", evidence: null };
          continue;
        }
        if (runs.length <= UNPLACED_RULES.parts_max) runsOf.set(idx, runs);
      }

      // The cards' own unplaced camera media, for the silences to cut in.
      const moving = [...runsOf.keys()];
      const mediaOf = new Map<number, number[]>();
      if (moving.length) {
        const { rows: media } = await client.query<{ idx: number; at: string }>(
          `SELECT w.idx, a.captured_at AS at
           FROM unnest($1::int[], $2::int[], $3::timestamptz[], $4::timestamptz[])
                AS w(idx, sid, t0, t1)
           JOIN assets a
             ON a.session_id = w.sid AND a.deleted_at IS NULL
            AND a.captured_at >= w.t0 AND a.captured_at <= w.t1
           WHERE ${TODO_CARD} AND NOT (${NO_EXIF})
           ORDER BY w.idx, a.captured_at`,
          [
            moving,
            moving.map((i) => groups[i].sessions[0].id),
            moving.map((i) => groups[i].t0),
            moving.map((i) => groups[i].t1),
          ],
        );
        for (const m of media) {
          const list = mediaOf.get(m.idx);
          if (list) list.push(Date.parse(m.at));
          else mediaOf.set(m.idx, [Date.parse(m.at)]);
        }
      }

      // One window per place, bounded by the card's own window: a place met
      // only in the padding (the phone at home before the shoot) gets an
      // empty window and no card.
      const windows: (WindowSpec & { k: number })[] = [];
      for (const [idx, runs] of runsOf) {
        const g = groups[idx];
        const T0 = Date.parse(g.t0);
        const T1 = Date.parse(g.t1);
        const clamp = (t: number) => Math.min(T1, Math.max(T0, t));
        const cuts = placeCuts(runs, mediaOf.get(idx) ?? []).map(clamp);
        const bounds = [T0, ...cuts, T1];
        for (let k = 0; k < runs.length; k++) {
          if (bounds[k + 1] <= bounds[k]) continue;
          windows.push({
            sid: g.sessions[0].id,
            idx,
            k,
            // The card's own bounds stay pg's strings (microseconds: an ISO
            // instant is milliseconds and would drop the last frame); a cut
            // is a new instant.
            t0: bounds[k] === T0 ? g.t0 : new Date(bounds[k]).toISOString(),
            t1: bounds[k + 1] === T1 ? g.t1 : new Date(bounds[k + 1]).toISOString(),
          });
        }
      }
      // tallyWindows keys its rows by (sid, idx): give each window its own idx.
      const tallies = await tallyWindows(
        client,
        windows.map((w, j) => ({ sid: w.sid, idx: j, t0: w.t0, t1: w.t1 })),
      );
      const placesOf = new Map<number, { w: (typeof windows)[number]; t: PartRow }[]>();
      for (const t of tallies) {
        const w = windows[t.idx];
        if (t.unplaced === 0) continue;
        const list = placesOf.get(w.idx);
        if (list) list.push({ w, t });
        else placesOf.set(w.idx, [{ w, t }]);
      }
      for (const [idx, places] of placesOf) {
        if (places.length < 2) continue;
        const g = groups[idx];
        const runs = runsOf.get(idx)!;
        g.stops = places.map(({ w, t }, n) => ({
          index: n + 1,
          t0: w.t0,
          t1: w.t1,
          first: t.first,
          last: t.last,
          total: t.total,
          unplaced: t.unplaced,
          no_exif: t.no_exif,
          sample: t.sample ?? [],
          suggestion: runSuggestion(runs[w.k].donors),
        }));
        // The other body's folder spans the same places: offered whole, it
        // would put both towns at one point again.
        g.siblings = [];
      }
    }

    // 6. The nearest human placement, for the cards nothing suggests: the
    //    position applied by hand or by an accepted suggestion closest in
    //    time to the card, within reuse_d days either side — the decision
    //    the maintainer already took for the folder shot the day before.
    //    Shown on the card and one click away; never a suggestion (§8.1).
    //    Two index walks per card on captured_at, bounded by reuse_d.
    const lonely = groups.flatMap((g, i) =>
      g.kind !== "span" && g.suggestion == null ? [i] : [],
    );
    if (lonely.length) {
      const { rows: near } = await client.query<{
        idx: number;
        lat: number;
        lon: number;
        at: string;
        city: string | null;
        country: string | null;
        folder: string;
        manual: boolean;
      }>(
        `WITH win AS (
           SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[]) AS w(idx, t0, t1)
         )
         SELECT DISTINCT ON (w.idx) w.idx, c.gps_lat AS lat, c.gps_lon AS lon, c.captured_at AS at,
                c.place_city AS city, c.place_country AS country, s.name AS folder,
                c.gps_source = 'manual' AS manual
         FROM win w
         CROSS JOIN LATERAL (
           (SELECT a.id, a.session_id, a.gps_lat, a.gps_lon, a.captured_at, a.place_city,
                   a.place_country, a.gps_source, w.t0 - a.captured_at AS gap
              FROM assets a
             WHERE a.captured_at < w.t0 AND a.captured_at >= w.t0 - $4::interval
               AND a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
               AND a.gps_source IN ('manual', 'inferred')
             ORDER BY a.captured_at DESC LIMIT 1)
           UNION ALL
           (SELECT a.id, a.session_id, a.gps_lat, a.gps_lon, a.captured_at, a.place_city,
                   a.place_country, a.gps_source, a.captured_at - w.t1 AS gap
              FROM assets a
             WHERE a.captured_at > w.t1 AND a.captured_at <= w.t1 + $4::interval
               AND a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
               AND a.gps_source IN ('manual', 'inferred')
             ORDER BY a.captured_at ASC LIMIT 1)
         ) c
         JOIN sessions s ON s.id = c.session_id
         ORDER BY w.idx, c.gap ASC`,
        [
          lonely,
          lonely.map((i) => groups[i].t0),
          lonely.map((i) => groups[i].t1),
          `${UNPLACED_RULES.reuse_d} days`,
        ],
      );
      for (const r of near) {
        const g = groups[r.idx];
        const at = Date.parse(r.at);
        const gap_h =
          at < Date.parse(g.t0)
            ? -(Date.parse(g.t0) - at) / H
            : (at - Date.parse(g.t1)) / H;
        g.nearest = {
          lat: Number(r.lat),
          lon: Number(r.lon),
          name: r.city ? (r.country ? `${r.city}, ${r.country}` : r.city) : r.country,
          folder: r.folder,
          gap_h,
          verified: r.manual === true,
        };
      }
    }

    // Worked from the top: the confident suggestions first, the biggest pile
    // first within a tier, the spans last. The page re-sorts on demand
    // (sortGroups); this is the order a client that does not gets.
    const ordered = sortGroups(groups, "ready");

    // The set-aside media's own counts (§12): on no card, each its own
    // dialog. Only the graded exports need a match to count, and that is
    // one pass over the located media's names (lib/unplacedAside.ts).
    const graded = Number(tally?.graded ?? 0) > 0 ? await gradedExports(client) : [];

    const ready = ordered.filter(isReady).length;
    return {
      groups: ordered,
      totals: {
        groups: ordered.length,
        placed: Number(tally?.placed ?? 0),
        unplaced: Number(tally?.unplaced ?? 0),
        exempt: Number(tally?.exempt ?? 0),
        no_exif: ordered.reduce((n, g) => n + g.no_exif, 0),
        ready,
        by_hand: ordered.length - ready,
        aside: {
          screenshots: Number(tally?.screenshots ?? 0),
          saved: Number(tally?.saved ?? 0),
          graded: Number(tally?.graded ?? 0),
          graded_matched: graded.filter((x) => x.source != null).length,
        },
      },
      rules: UNPLACED_RULES,
    };
  });
}

// The positions already applied by a human — a hand-placed pin ('manual') or
// an accepted suggestion ('inferred') — within reuse_d days of a card's
// window, nearest first: the decision the maintainer already took for the
// folder shot the day before, offered back as one click in the Place dialog.
// They are OFFERED, never pre-filled and never a donor: an 'inferred' spot
// seeding a suggestion is the self-filling backlog scan 4 refuses, while a
// human picking it from a list on a map is a human placing a pin. One spot
// per coordinate to 4 decimals (~10 m) — a bulk placement writes one
// coordinate for a whole folder. Served by captured_at's index: only the
// rows of the ±reuse_d range are read.
export async function placesNear(
  from: string,
  to: string,
  limit = 6,
): Promise<UnplacedPlace[]> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");
    const { rows } = await client.query<{
      lat: number;
      lon: number;
      n: number;
      last_before: string | null;
      first_after: string | null;
      inside: number;
      city: string | null;
      country: string | null;
      verified: boolean;
    }>(
      `SELECT round(a.gps_lat::numeric, 4)::float8 AS lat,
              round(a.gps_lon::numeric, 4)::float8 AS lon,
              count(*)::int AS n,
              max(a.captured_at) FILTER (WHERE a.captured_at < $1::timestamptz) AS last_before,
              min(a.captured_at) FILTER (WHERE a.captured_at > $2::timestamptz) AS first_after,
              count(*) FILTER (WHERE a.captured_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS inside,
              mode() WITHIN GROUP (ORDER BY a.place_city) AS city,
              mode() WITHIN GROUP (ORDER BY a.place_country) AS country,
              bool_or(a.gps_source = 'manual') AS verified
       FROM assets a
       WHERE a.deleted_at IS NULL
         AND a.gps_lat IS NOT NULL
         AND a.gps_source IN ('manual', 'inferred')
         AND a.captured_at >= $1::timestamptz - $3::interval
         AND a.captured_at <= $2::timestamptz + $3::interval
       GROUP BY 1, 2`,
      [from, to, `${UNPLACED_RULES.reuse_d} days`],
    );
    const t0 = Date.parse(from);
    const t1 = Date.parse(to);
    const places: UnplacedPlace[] = rows.map((r) => {
      const before = r.last_before ? (t0 - Date.parse(r.last_before)) / H : Infinity;
      const after = r.first_after ? (Date.parse(r.first_after) - t1) / H : Infinity;
      const gap_h = r.inside > 0 ? 0 : before <= after ? -before : after;
      const name = r.city ? (r.country ? `${r.city}, ${r.country}` : r.city) : r.country;
      return {
        lat: Number(r.lat),
        lon: Number(r.lon),
        name: name ?? null,
        count: r.n,
        gap_h,
        verified: r.verified,
      };
    });
    return places
      .sort((a, b) => Math.abs(a.gap_h) - Math.abs(b.gap_h) || b.count - a.count)
      .slice(0, limit);
  });
}
