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
// Read-only: the write is POST /api/assets/geotag/points, after the dialog.
import { tx } from "./db";
import { positionAt, type MatchOptions, type TrackPoint } from "./trackParse";
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
// else the nearest frame within a quarter of an hour.
const FRAME_MATCH: MatchOptions = {
  maxBracketMin: 60,
  maxNearestMin: 15,
  maxKmh: 200,
  maxStillHours: 12,
  maxStillKm: 2,
};

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

/** The card's frames matched against the chosen sources, grouped in stops. */
export async function traceCard(opts: {
  sessionId: number;
  from: string;
  to: string;
  imports: number[];
  models: (string | null)[];
}): Promise<TraceResponse> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");

    // The card's frames still to place, in time order — camera media only:
    // a screenshot taken on the trip is not a photograph of the place, and
    // the view's verb for those is Exempt, not a position (§9.4).
    const { rows: todo } = await client.query<{ id: number; at: string }>(
      `SELECT a.id, a.captured_at AS at
       FROM assets a
       WHERE a.session_id = $1 AND a.deleted_at IS NULL
         AND a.gps_lat IS NULL AND a.geo_exempt_at IS NULL
         AND NOT (a.camera_model IS NULL AND a.lens IS NULL)
         AND a.captured_at >= $2::timestamptz AND a.captured_at <= $3::timestamptz
       ORDER BY a.captured_at, a.id`,
      [opts.sessionId, opts.from, opts.to],
    );

    // Each import's fixes, matched with that import's own rule.
    const tracks: { id: number; points: TrackPoint[]; match: MatchOptions }[] = [];
    if (opts.imports.length) {
      const { rows: meta } = await client.query<{ id: number; match: MatchOptions | null }>(
        `SELECT id, report->'match' AS match FROM track_imports WHERE id = ANY($1::bigint[])`,
        [opts.imports],
      );
      const { rows: pts } = await client.query<{ import_id: number; t: string; lat: number; lon: number }>(
        `SELECT import_id, t, lat, lon FROM track_points
         WHERE import_id = ANY($1::bigint[])
           AND t >= $2::timestamptz - $4::interval AND t <= $3::timestamptz + $4::interval
         ORDER BY import_id, t`,
        [opts.imports, opts.from, opts.to, PAD],
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
    if (opts.models.length) {
      const mc = modelClause(opts.models, 4);
      const { rows } = await client.query<{ at: string; lat: number; lon: number }>(
        `SELECT a.captured_at AS at, a.gps_lat AS lat, a.gps_lon AS lon
         FROM assets a
         WHERE a.captured_at >= $1::timestamptz - $3::interval
           AND a.captured_at <= $2::timestamptz + $3::interval
           AND a.deleted_at IS NULL AND a.gps_lat IS NOT NULL
           AND (a.gps_source IS NULL OR a.gps_source IN ('manual', 'track'))
           AND ${mc.sql}
         ORDER BY a.captured_at`,
        [opts.from, opts.to, PAD, ...mc.params],
      );
      framePoints = rows.map((r) => ({ t: Date.parse(r.at), lat: Number(r.lat), lon: Number(r.lon) }));
    }

    // An imported track first — a measurement — then the frames.
    const frames: TraceFrame[] = todo.map((r) => {
      const at = Date.parse(r.at);
      for (const tr of tracks) {
        const fix = positionAt(tr.points, at, tr.match);
        if (fix) return { id: Number(r.id), at, pos: { lat: fix.lat, lon: fix.lon }, source: "track", import_id: tr.id };
      }
      const fix = positionAt(framePoints, at, FRAME_MATCH);
      return fix
        ? { id: Number(r.id), at, pos: { lat: fix.lat, lon: fix.lon }, source: "inferred", import_id: null }
        : { id: Number(r.id), at, pos: null, source: null, import_id: null };
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
