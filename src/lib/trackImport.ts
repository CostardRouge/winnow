// An imported GPS track — a Polarsteps export, a GPX — applied to the library
// (migration 0047). The DATABASE half; reading the files is lib/trackParse.ts.
//
// For every live frame shot inside the track's span:
//   - a frame with NO position takes the track's position at its instant
//     (interpolated between two close fixes, else the nearest fix within
//     minutes) as gps_source='track', and that place's offset for its capture
//     day (capture_offset_source='track', migration 0046);
//   - a frame in a GAP of the track keeps no position but takes the zone the
//     traveller was in (the trip's step timeline, else the nearest fix);
//   - a frame whose own file placed it is never moved — but if the track puts
//     it far away at that instant, that is reported as a CONFLICT: the
//     signature of a camera whose clock was wrong, worth a human look;
//   - a human-set position ('manual') and a bulk-accepted one ('inferred') are
//     left alone, and counted.
//
// Like the rest of Winnow's repairs it is two gestures: a PREVIEW that writes
// nothing and says what would happen, and an APPLY that records the import
// (track_imports) so Undo can take back exactly what it wrote. Nothing is ever
// written into an original: a track position is a database fact, kept through
// re-indexing by the indexer's guard, like 'inferred'.
import { pool } from "./db";
import { config } from "./config";
import { enqueueGeocode } from "./queue";
import {
  localDay,
  outranks,
  placeOffsetMinutes,
  type CapturedAtSource,
  type OffsetSource,
} from "./captureZone";
import { applyOwnZones, inheritNeighbourZones } from "./captureDays";
import {
  distanceKm,
  offsetAt,
  positionAt,
  type MatchOptions,
  type ParsedTrack,
} from "./trackParse";

/** A camera fix this far from the track at its instant is reported. */
export const CONFLICT_KM = 25;

const UNNEST_BATCH = 2000;

export type TrackDay = { day: string; located: number; zoned: number; own: number };

export type TrackConflict = {
  id: number;
  filename: string;
  device: string | null;
  at: string;
  km: number;
};

export type TrackImportReport = {
  apply: boolean;
  importId: number | null;
  name: string;
  kind: ParsedTrack["kind"];
  points: number;
  steps: number;
  span: { start: string; end: string };
  /** Live frames whose instant falls inside the span. */
  inSpan: number;
  located: { interpolated: number; still: number; nearest: number };
  /** In a gap of the track: zone written, no position. */
  zonedOnly: number;
  /** In a gap with no zone known either. */
  unmatched: number;
  ownPosition: number;
  manualKept: number;
  inferredKept: number;
  /** Times indexed before 0046 and not yet classified: skipped, said. */
  unclassified: number;
  conflictCount: number;
  conflicts: TrackConflict[];
  /** Frames whose capture day this import moves. */
  daysChanged: number;
  days: TrackDay[];
  match: Required<MatchOptions>;
};

type Row = {
  id: string | number;
  filename: string;
  device: string | null;
  captured_ms: string | number;
  captured_at_source: CapturedAtSource | null;
  gps_lat: number | null;
  gps_lon: number | null;
  gps_source: string | null;
  capture_offset_min: number | null;
  capture_offset_source: OffsetSource | null;
  day: string | null;
};

type Placed = { id: number; lat: number; lon: number; offset: number | null };
type Zoned = { id: number; offset: number };

/**
 * Preview (`apply: false`, the default) or apply one parsed track. The preview
 * reads only; the apply writes in one transaction, then runs the neighbour
 * pass over the span and queues the geocoder for the frames it placed.
 */
export async function runTrackImport(
  track: ParsedTrack,
  opts: { apply?: boolean; name?: string; match?: MatchOptions } = {},
): Promise<TrackImportReport> {
  const apply = opts.apply === true;
  const match: Required<MatchOptions> = {
    maxBracketMin: opts.match?.maxBracketMin ?? 60,
    maxNearestMin: opts.match?.maxNearestMin ?? 15,
    maxKmh: opts.match?.maxKmh ?? 200,
    maxStillHours: opts.match?.maxStillHours ?? 12,
    maxStillKm: opts.match?.maxStillKm ?? 2,
  };
  const start = track.points[0].t;
  const end = track.points[track.points.length - 1].t;
  const name = (opts.name ?? track.name ?? `Track ${new Date(start).toISOString().slice(0, 10)}`).slice(0, 200);

  const report: TrackImportReport = {
    apply,
    importId: null,
    name,
    kind: track.kind,
    points: track.points.length,
    steps: track.steps.length,
    span: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    inSpan: 0,
    located: { interpolated: 0, still: 0, nearest: 0 },
    zonedOnly: 0,
    unmatched: 0,
    ownPosition: 0,
    manualKept: 0,
    inferredKept: 0,
    unclassified: 0,
    conflictCount: 0,
    conflicts: [],
    daysChanged: 0,
    days: [],
    match,
  };

  // A wall clock may sit up to 14 h either side of its instant: widen the read.
  const { rows } = await pool.query<Row>(
    `SELECT id, filename, device,
            (extract(epoch FROM captured_at) * 1000)::float8 AS captured_ms,
            captured_at_source, gps_lat, gps_lon, gps_source,
            capture_offset_min, capture_offset_source,
            to_char(capture_date, 'YYYY-MM-DD') AS day
       FROM assets
      WHERE deleted_at IS NULL AND captured_at IS NOT NULL
        AND captured_at BETWEEN to_timestamp($1 / 1000.0) - interval '15 hours'
                            AND to_timestamp($2 / 1000.0) + interval '15 hours'`,
    [start, end],
  );

  const placed: Placed[] = [];
  const zoned: Zoned[] = [];
  const inSpanIds: number[] = [];
  const days = new Map<string, TrackDay>();
  const conflicts: TrackConflict[] = [];
  const bump = (d: string, k: "located" | "zoned" | "own") => {
    const e = days.get(d) ?? { day: d, located: 0, zoned: 0, own: 0 };
    e[k]++;
    days.set(d, e);
  };

  for (const r of rows) {
    const id = Number(r.id);
    const ms = Number(r.captured_ms);
    const fromFile = r.gps_lat != null && r.gps_source == null;
    if (r.captured_at_source == null && !fromFile) {
      // Zoned instant or wall clock? Only the Dates & places re-read knows.
      if (ms >= start && ms <= end) report.unclassified++;
      continue;
    }
    let instant = ms;
    if (r.captured_at_source === "exif-wall") {
      const off = offsetAt(track, ms);
      if (off == null) continue;
      instant = ms - off * 60000;
    }
    if (instant < start || instant > end) continue;
    report.inSpan++;
    inSpanIds.push(id);
    const fix = positionAt(track.points, instant, match);
    const before = r.day;

    if (fromFile) {
      report.ownPosition++;
      bump(before ?? localDay(new Date(ms), r.captured_at_source, r.capture_offset_min), "own");
      if (fix) {
        const d = distanceKm({ lat: r.gps_lat!, lon: r.gps_lon! }, fix);
        if (d > CONFLICT_KM) {
          report.conflictCount++;
          conflicts.push({
            id,
            filename: r.filename,
            device: r.device,
            at: new Date(instant).toISOString(),
            km: Math.round(d),
          });
        }
      }
      continue;
    }
    if (r.gps_source === "manual") {
      report.manualKept++;
      continue;
    }
    if (r.gps_source === "inferred") {
      report.inferredKept++;
      continue;
    }

    // No position, or a previous import's: the track decides.
    let offset: number | null = null;
    if (fix) {
      offset = placeOffsetMinutes(fix.lat, fix.lon, new Date(instant));
      placed.push({ id, lat: fix.lat, lon: fix.lon, offset });
      report.located[fix.method]++;
    } else {
      const off = offsetAt(track, instant);
      if (off != null && outranks("track", r.capture_offset_source)) {
        offset = off;
        zoned.push({ id, offset: off });
        report.zonedOnly++;
      } else report.unmatched++;
    }
    const after = localDay(
      new Date(ms),
      r.captured_at_source,
      offset ?? r.capture_offset_min,
    );
    if (before && after !== before) report.daysChanged++;
    bump(after, fix ? "located" : "zoned");
  }

  conflicts.sort((a, b) => b.km - a.km);
  report.conflicts = conflicts.slice(0, 50);
  report.days = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (!apply) return report;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: string }>(
      `INSERT INTO track_imports (name, kind, span_start, span_end, point_count, report)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), $5, '{}'::jsonb)
       RETURNING id`,
      [name, track.kind, start, end, track.points.length],
    );
    const importId = Number(ins.rows[0].id);
    report.importId = importId;
    for (let i = 0; i < placed.length; i += UNNEST_BATCH) {
      const b = placed.slice(i, i + UNNEST_BATCH);
      await client.query(
        `UPDATE assets a SET
           gps = jsonb_build_object('lat', u.lat, 'lon', u.lon),
           gps_source = 'track',
           gps_write_status = 'skipped', gps_write_error = NULL,
           geocode_status = 'pending', geocode_error = NULL,
           capture_offset_min = COALESCE(u.off, a.capture_offset_min),
           capture_offset_source = CASE WHEN u.off IS NULL THEN a.capture_offset_source ELSE 'track' END,
           track_import_id = $5,
           updated_at = now()
         FROM unnest($1::bigint[], $2::float8[], $3::float8[], $4::smallint[]) AS u(id, lat, lon, off)
         WHERE a.id = u.id
           AND (a.gps IS NULL OR a.gps_source = 'track')`,
        [b.map((p) => p.id), b.map((p) => p.lat), b.map((p) => p.lon), b.map((p) => p.offset), importId],
      );
    }
    for (let i = 0; i < zoned.length; i += UNNEST_BATCH) {
      const b = zoned.slice(i, i + UNNEST_BATCH);
      await client.query(
        `UPDATE assets a SET
           capture_offset_min = u.off, capture_offset_source = 'track',
           track_import_id = $3
         FROM unnest($1::bigint[], $2::smallint[]) AS u(id, off)
         WHERE a.id = u.id`,
        [b.map((z) => z.id), b.map((z) => z.offset), importId],
      );
    }
    await client.query("UPDATE track_imports SET report = $2 WHERE id = $1", [
      importId,
      JSON.stringify(report),
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The located frames are donors now: lend their zone to the span's others.
  await inheritNeighbourZones({ ids: inSpanIds });
  if (config.geocode.enabled) for (const p of placed) await enqueueGeocode(p.id);
  return report;
}

export type TrackImportRow = {
  id: number;
  name: string;
  kind: string;
  span_start: string;
  span_end: string;
  point_count: number;
  created_at: string;
  placed: number;
  zoned: number;
};

/** Applied imports, newest first, with what each still holds. */
export async function listTrackImports(): Promise<TrackImportRow[]> {
  const { rows } = await pool.query<TrackImportRow>(
    `SELECT t.id, t.name, t.kind, t.span_start, t.span_end, t.point_count, t.created_at,
            count(a.id) FILTER (WHERE a.gps_source = 'track')::int AS placed,
            count(a.id) FILTER (WHERE a.capture_offset_source = 'track')::int AS zoned
       FROM track_imports t
       LEFT JOIN assets a ON a.track_import_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC`,
  );
  return rows;
}

/**
 * Undo one import: take back the positions and zones it wrote (and only
 * those — a frame re-placed by hand since keeps its new position), forget the
 * import, then let the capture-day passes decide those frames again.
 */
export async function revertTrackImport(
  importId: number,
): Promise<{ found: boolean; unplaced: number; unzoned: number }> {
  const client = await pool.connect();
  let ids: number[] = [];
  let unplaced = 0;
  let unzoned = 0;
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT 1 FROM track_imports WHERE id = $1", [importId]);
    if (!exists.rowCount) {
      await client.query("ROLLBACK");
      return { found: false, unplaced: 0, unzoned: 0 };
    }
    const touched = await client.query<{ id: string }>(
      "SELECT id FROM assets WHERE track_import_id = $1",
      [importId],
    );
    ids = touched.rows.map((r) => Number(r.id));
    const a = await client.query(
      `UPDATE assets SET gps = NULL, gps_source = NULL, place_id = NULL,
              -- the names go with the position: left behind, an undone frame
              -- stayed under "Australia" in the facets with no position.
              place_country = NULL, place_region = NULL, place_county = NULL,
              place_city = NULL, place_poi = NULL,
              geocode_status = 'skipped', geocode_error = NULL, updated_at = now()
        WHERE track_import_id = $1 AND gps_source = 'track'`,
      [importId],
    );
    unplaced = a.rowCount ?? 0;
    const z = await client.query(
      `UPDATE assets SET capture_offset_min = NULL, capture_offset_source = NULL
        WHERE track_import_id = $1 AND capture_offset_source = 'track'`,
      [importId],
    );
    unzoned = z.rowCount ?? 0;
    await client.query("UPDATE assets SET track_import_id = NULL WHERE track_import_id = $1", [
      importId,
    ]);
    await client.query("DELETE FROM track_imports WHERE id = $1", [importId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await applyOwnZones(ids);
  await inheritNeighbourZones({ ids });
  return { found: true, unplaced, unzoned };
}
