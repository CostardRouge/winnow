// "Follow a track…" — the Unplaced view placing a card's frames ONE BY ONE
// from a track, rather than all at one pin (docs/UNPLACED.md §11).
//
// A track here is whatever knows where the photographer was, minute by
// minute, around the card's hours:
//   - the fixes of an applied GPS import (Polarsteps, GPX), kept since 0052;
//   - the trustworthy located frames shot in those hours — the phone in the
//     pocket is a GPS logger that happens to take pictures — grouped by the
//     body that shot them, so a friend's camera can be left out.
// Each frame of the card is matched against it with the import's own rule
// (positionAt: between two close fixes, or the same spot over a still hour,
// or the nearest fix within minutes, else nothing — a gap is not a position).
// Consecutive frames that stay within split_km make a STOP (traceStops), the
// unit the dialog lists, shows and lets the human accept.
//
// What it records is decided by the source of each frame's fix, never by the
// human: an imported track's fix is 'track' (a timed measurement, trusted
// like a camera fix — the import's own value, carrying its track_import_id so
// that import's Undo takes it back too); a fix from other frames is
// 'inferred' (the folder-scale guess's value: a bridge for Atelier, never a
// vote, never written into an original). Nothing here ever writes 'manual'.
//
// The same matching, with the sources chosen for the human ("auto"), is
// "each frame by its neighbours" (§13): every applied import that covers the
// hours, and every located frame shot then except by a body marked on /gear
// as someone else's or as no camera. neighbourCounts() runs it for every card
// of the list at once, from each frame's two nearest fixes — all that
// positionAt ever reads.
//
// Read-only: the write is POST /api/assets/geotag/points, after the dialog.
import type { PoolClient } from "pg";
import { tx } from "./db";
import { positionAt, type MatchOptions, type TrackPoint } from "./trackParse";
import { NO_EXIF, TODO_CARD } from "./unplacedSql";
import {
  UNPLACED_RULES,
  traceStops,
  type TraceFrame,
  type TraceResponse,
  type TraceSource,
} from "./unplacedTypes";

// How far either side of the card's window a fix may sit and still count:
// the import's "still" rule bridges up to 12 h between two fixes at the same
// spot (a night in one town), so the read reaches that far.
const PAD = "12 hours";

// The phone's own frames, matched with the import's defaults: interpolate
// between two frames up to an hour apart, the same spot over a still day,
// else the nearest frame within a quarter of an hour. The numbers are the
// printed rules' (UNPLACED_RULES.frame_*), so the page says what this does.
const FRAME_MATCH: MatchOptions = {
  maxBracketMin: UNPLACED_RULES.frame_bracket_min,
  maxNearestMin: UNPLACED_RULES.frame_nearest_min,
  maxKmh: UNPLACED_RULES.frame_kmh,
  maxStillHours: UNPLACED_RULES.frame_still_h,
  maxStillKm: UNPLACED_RULES.tight_km,
};

// A located frame a track may be made of: a camera fix, a hand-placed pin or
// an imported track's — never an 'inferred' guess (§4.2).
const TRUSTED = (b: string) =>
  `${b}.deleted_at IS NULL AND ${b}.gps_lat IS NOT NULL
   AND (${b}.gps_source IS NULL OR ${b}.gps_source IN ('manual', 'track'))`;
// …and, when the sources are chosen for the human, not shot by a body /gear
// says is someone else's or no camera (gear_owners, 0053): a friend's camera
// elsewhere would pull frames to it. A body with no row is not assumed either
// way, so it counts.
const NOT_OTHERS = (b: string) =>
  `NOT EXISTS (SELECT 1 FROM gear_owners o WHERE o.device = ${b}.device AND o.owner IN ('other', 'none'))`;

// The card's frames a track places: unplaced, not set aside (a graded
// export's hours are its export's), camera media only — a screenshot taken on
// the trip is not a photograph of the place (§9.4).
const PLACEABLE = `${TODO_CARD} AND NOT (${NO_EXIF})`;

type Track = { id: number; points: TrackPoint[]; match: MatchOptions };
type Matched = Pick<TraceFrame, "pos" | "source" | "import_id">;

// One frame against the sources: an imported track first — a measurement —
// then the located frames. The one rule both the dialog and the list's count
// apply. Pure.
function matchFrame(at: number, tracks: readonly Track[], frames: TrackPoint[]): Matched {
  for (const tr of tracks) {
    const fix = positionAt(tr.points, at, tr.match);
    if (fix) return { pos: { lat: fix.lat, lon: fix.lon }, source: "track", import_id: tr.id };
  }
  const fix = positionAt(frames, at, FRAME_MATCH);
  return fix
    ? { pos: { lat: fix.lat, lon: fix.lon }, source: "inferred", import_id: null }
    : { pos: null, source: null, import_id: null };
}

const LINE_MAX = 400;

// The camera_model filter, with "no camera named" as a real choice: SQL's
// `= ANY` never matches a NULL.
function modelClause(models: (string | null)[], start: number) {
  const named = models.filter((m): m is string => m != null);
  const withNull = models.some((m) => m == null);
  const parts: string[] = [];
  const params: unknown[] = [];
  if (named.length) {
    parts.push(`a.camera_model = ANY($${start}::text[])`);
    params.push(named);
  }
  if (withNull) parts.push("a.camera_model IS NULL");
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "false", params };
}

/** What a track could be made of around [from, to]. */
export async function traceSources(from: string, to: string): Promise<TraceSource[]> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");
    const { rows: imports } = await client.query<{
      id: number;
      name: string;
      kind: string;
      span_start: string;
      span_end: string;
      points: number;
    }>(
      `SELECT t.id, t.name, t.kind, t.span_start, t.span_end, count(*)::int AS points
       FROM track_points p
       JOIN track_imports t ON t.id = p.import_id
       WHERE p.t >= $1::timestamptz - interval '1 hour'
         AND p.t <= $2::timestamptz + interval '1 hour'
       GROUP BY t.id
       ORDER BY t.span_start`,
      [from, to],
    );
    const { rows: frames } = await client.query<{ model: string | null; points: number }>(
      `SELECT a.camera_model AS model, count(*)::int AS points
       FROM assets a
       WHERE a.captured_at >= $1::timestamptz - interval '1 hour'
         AND a.captured_at <= $2::timestamptz + interval '1 hour'
         AND a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
         AND (a.gps_source IS NULL OR a.gps_source IN ('manual', 'track'))
       GROUP BY a.camera_model
       ORDER BY count(*) DESC`,
      [from, to],
    );
    return [
      ...imports.map(
        (i): TraceSource => ({
          kind: "import",
          id: Number(i.id),
          name: i.name,
          import_kind: i.kind,
          span_start: i.span_start,
          span_end: i.span_end,
          points: i.points,
        }),
      ),
      ...frames.map((f): TraceSource => ({ kind: "frames", model: f.model, points: f.points })),
    ];
  });
}

/** The card's frames matched against the chosen sources, grouped in stops.
 *  `auto`: the sources are chosen for the human — every import covering the
 *  hours, every located frame but those of someone else's body (§13). */
export async function traceCard(opts: {
  sessionId: number;
  from: string;
  to: string;
  imports: number[];
  models: (string | null)[];
  auto?: boolean;
}): Promise<TraceResponse> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");

    // The card's frames still to place, in time order.
    const { rows: todo } = await client.query<{ id: number; at: string }>(
      `SELECT a.id, a.captured_at AS at
       FROM assets a
       WHERE a.session_id = $1 AND a.deleted_at IS NULL
         AND ${PLACEABLE}
         AND a.captured_at >= $2::timestamptz AND a.captured_at <= $3::timestamptz
       ORDER BY a.captured_at, a.id`,
      [opts.sessionId, opts.from, opts.to],
    );

    let imports = opts.imports;
    if (opts.auto) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT DISTINCT import_id AS id FROM track_points
         WHERE t >= $1::timestamptz - $3::interval AND t <= $2::timestamptz + $3::interval`,
        [opts.from, opts.to, PAD],
      );
      imports = rows.map((r) => Number(r.id));
    }

    // Each import's fixes, matched with that import's own rule.
    const tracks: Track[] = [];
    if (imports.length) {
      const { rows: meta } = await client.query<{ id: number; match: MatchOptions | null }>(
        `SELECT id, report->'match' AS match FROM track_imports WHERE id = ANY($1::bigint[])`,
        [imports],
      );
      const { rows: pts } = await client.query<{ import_id: number; t: string; lat: number; lon: number }>(
        `SELECT import_id, t, lat, lon FROM track_points
         WHERE import_id = ANY($1::bigint[])
           AND t >= $2::timestamptz - $4::interval AND t <= $3::timestamptz + $4::interval
         ORDER BY import_id, t`,
        [imports, opts.from, opts.to, PAD],
      );
      for (const m of meta) {
        tracks.push({
          id: Number(m.id),
          match: m.match ?? {},
          points: pts
            .filter((p) => Number(p.import_id) === Number(m.id))
            .map((p) => ({ t: Date.parse(p.t), lat: Number(p.lat), lon: Number(p.lon) })),
        });
      }
    }

    // The located frames of the chosen bodies, as one more track.
    let framePoints: TrackPoint[] = [];
    if (opts.auto || opts.models.length) {
      const mc = opts.auto ? { sql: NOT_OTHERS("a"), params: [] } : modelClause(opts.models, 4);
      const { rows } = await client.query<{ at: string; lat: number; lon: number }>(
        `SELECT a.captured_at AS at, a.gps_lat AS lat, a.gps_lon AS lon
         FROM assets a
         WHERE a.captured_at >= $1::timestamptz - $3::interval
           AND a.captured_at <= $2::timestamptz + $3::interval
           AND ${TRUSTED("a")}
           AND ${mc.sql}
         ORDER BY a.captured_at`,
        [opts.from, opts.to, PAD, ...mc.params],
      );
      framePoints = rows.map((r) => ({ t: Date.parse(r.at), lat: Number(r.lat), lon: Number(r.lon) }));
    }

    const frames: TraceFrame[] = todo.map((r) => {
      const at = Date.parse(r.at);
      return { id: Number(r.id), at, ...matchFrame(at, tracks, framePoints) };
    });

    const { runs, gaps } = traceStops(
      frames,
      UNPLACED_RULES.split_km * 1000,
      UNPLACED_RULES.stay_min * 60_000,
    );
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = (s.length - 1) / 2;
      return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
    };
    const stops = runs.map((r, i) => ({
      index: i + 1,
      name: null as string | null,
      lat: med(r.frames.map((f) => f.pos!.lat)),
      lon: med(r.frames.map((f) => f.pos!.lon)),
      moving: r.moving,
      ids: r.frames.map((f) => f.id),
      t0: r.frames[0].at,
      t1: r.frames[r.frames.length - 1].at,
    }));

    // A name for each stop: the nearest geocoded cell within split_km, which
    // costs no call to the geocoder (the cells are the library's own places).
    if (stops.length) {
      const deg = UNPLACED_RULES.split_km / 111;
      const { rows: names } = await client.query<{ i: number; city: string | null; country: string | null }>(
        `SELECT s.i, p.city, p.country
         FROM unnest($1::int[], $2::float8[], $3::float8[]) AS s(i, lat, lon)
         CROSS JOIN LATERAL (
           SELECT city, country FROM places
           WHERE cell_lat BETWEEN s.lat - $4 AND s.lat + $4
             AND cell_lon BETWEEN s.lon - $4 * 2 AND s.lon + $4 * 2
             AND (city IS NOT NULL OR country IS NOT NULL)
           ORDER BY (cell_lat - s.lat) ^ 2 + (cell_lon - s.lon) ^ 2
           LIMIT 1
         ) p`,
        [stops.map((s) => s.index), stops.map((s) => s.lat), stops.map((s) => s.lon), deg],
      );
      for (const n of names) {
        const s = stops[n.i - 1];
        s.name = n.city ? (n.country ? `${n.city}, ${n.country}` : n.city) : n.country;
      }
    }

    // The line the map draws: every fix used, in time order, thinned.
    const all = [...tracks.flatMap((t) => t.points), ...framePoints].sort((a, b) => a.t - b.t);
    const step = Math.max(1, Math.ceil(all.length / LINE_MAX));
    const line = all.filter((_, i) => i % step === 0).map((p) => ({ lat: p.lat, lon: p.lon }));

    return { stops, gaps, line, frames };
  });
}

// "Each frame by its neighbours" for many cards at once (§13), as the list
// needs it: for each card's placeable frames, the trusted located frame at or
// just before its minute and the one just after (each within PAD — two walks
// down captured_at's index per frame), and the kept fixes of every import
// around the card. positionAt reads nothing but the two fixes around an
// instant, so this is the dialog's own answer at a fraction of the reads.
// Sources as `auto`: someone else's body never counts. Returns, per card, its
// frames and where each one landed.
export async function neighbourCounts(
  client: PoolClient,
  cards: { idx: number; sid: number; t0: string; t1: string }[],
): Promise<Map<number, { at: number; pos: { lat: number; lon: number } | null }[]>> {
  const out = new Map<number, { at: number; pos: { lat: number; lon: number } | null }[]>();
  if (!cards.length) return out;
  const args = [
    cards.map((c) => c.idx),
    cards.map((c) => c.sid),
    cards.map((c) => c.t0),
    cards.map((c) => c.t1),
  ];
  const { rows } = await client.query<{
    idx: number;
    at: string;
    p_at: string | null;
    p_lat: number | null;
    p_lon: number | null;
    n_at: string | null;
    n_lat: number | null;
    n_lon: number | null;
  }>(
    `SELECT w.idx, a.captured_at AS at,
            p.captured_at AS p_at, p.gps_lat AS p_lat, p.gps_lon AS p_lon,
            n.captured_at AS n_at, n.gps_lat AS n_lat, n.gps_lon AS n_lon
     FROM unnest($1::int[], $2::int[], $3::timestamptz[], $4::timestamptz[]) AS w(idx, sid, t0, t1)
     JOIN assets a
       ON a.session_id = w.sid AND a.deleted_at IS NULL
      AND a.captured_at >= w.t0 AND a.captured_at <= w.t1
     LEFT JOIN LATERAL (
       SELECT b.captured_at, b.gps_lat, b.gps_lon FROM assets b
       WHERE b.captured_at <= a.captured_at AND b.captured_at >= a.captured_at - $5::interval
         AND ${TRUSTED("b")} AND ${NOT_OTHERS("b")}
       ORDER BY b.captured_at DESC LIMIT 1
     ) p ON true
     LEFT JOIN LATERAL (
       SELECT b.captured_at, b.gps_lat, b.gps_lon FROM assets b
       WHERE b.captured_at > a.captured_at AND b.captured_at <= a.captured_at + $5::interval
         AND ${TRUSTED("b")} AND ${NOT_OTHERS("b")}
       ORDER BY b.captured_at ASC LIMIT 1
     ) n ON true
     WHERE ${PLACEABLE}
     ORDER BY w.idx, a.captured_at`,
    [...args, PAD],
  );
  if (!rows.length) return out;

  // The imports around each card: few, and sparse — read whole.
  const { rows: pts } = await client.query<{
    idx: number;
    import_id: string;
    t: string;
    lat: number;
    lon: number;
    match: MatchOptions | null;
  }>(
    `SELECT w.idx, p.import_id, p.t, p.lat, p.lon, ti.report->'match' AS match
     FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[]) AS w(idx, t0, t1)
     JOIN track_points p ON p.t >= w.t0 - $4::interval AND p.t <= w.t1 + $4::interval
     JOIN track_imports ti ON ti.id = p.import_id
     ORDER BY w.idx, p.import_id, p.t`,
    [args[0], args[2], args[3], PAD],
  );
  const tracksOf = new Map<number, Track[]>();
  for (const r of pts) {
    const list = tracksOf.get(r.idx) ?? [];
    let tr = list.find((x) => x.id === Number(r.import_id));
    if (!tr) {
      tr = { id: Number(r.import_id), points: [], match: r.match ?? {} };
      list.push(tr);
      tracksOf.set(r.idx, list);
    }
    tr.points.push({ t: Date.parse(r.t), lat: Number(r.lat), lon: Number(r.lon) });
  }

  for (const r of rows) {
    const at = Date.parse(r.at);
    const near: TrackPoint[] = [];
    if (r.p_at) near.push({ t: Date.parse(r.p_at), lat: Number(r.p_lat), lon: Number(r.p_lon) });
    if (r.n_at) near.push({ t: Date.parse(r.n_at), lat: Number(r.n_lat), lon: Number(r.n_lon) });
    const m = matchFrame(at, tracksOf.get(r.idx) ?? [], near);
    const list = out.get(r.idx) ?? [];
    list.push({ at, pos: m.pos });
    out.set(r.idx, list);
  }
  return out;
}
