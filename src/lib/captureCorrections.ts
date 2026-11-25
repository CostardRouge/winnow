// Correcting a camera clock that was wrong (migrations 0061–0062,
// docs/CAPTURE-TIME.md).
//
// A correction is a SHIFT added to what the file says — never a date typed
// over it, never written into the original (the maintainer's call C1). The
// trigger of 0061 keeps `captured_at = captured_at_file + capture_shift_s`, so
// this module writes `capture_shift_s` and, for a time-zone correction, the
// zone the day is filed in (`capture_offset_source = 'manual'`, 0062). Every
// reader (filters, the calendar, the capture day, Atelier) follows.
//
// Five ways to say what the right time was (CorrectionRequest.mode):
//   shift   ±N seconds on every ticked frame;
//   set     one frame's local time typed in, the others keep their gaps;
//   match   a frame of the wrong clock and one of a right clock that show the
//           same moment — the gap between their local times is the shift;
//   zone    "the camera was on Paris time, I was in Brisbane": a file that
//           WROTE its zone had the right moment, so only its day's zone is
//           set; a wall clock (no zone in the file) is shifted by the zones'
//           difference at its own date, summer time included;
//   revert  back to what the files say, zone included.
//
// The gesture is Preview → Apply → Undo, like a GPS track import (0047):
//   planCorrection()   reads only: what would move, day by day;
//   applyCorrection()  one transaction: the record, each row's before/after
//                      (shift, zone, track position), the writes, then what
//                      depends on the moment (session and pile spans, own and
//                      borrowed zones). A frame a GPS track placed at its OLD
//                      moment is matched against the same track at the new
//                      one: moved, or taken off when the track has no fix then;
//   undoCorrection()   puts back only what this gesture still owns — a row a
//                      later correction moved again is left, and counted.
// Pushing the corrected dates to Immich happens after the commit, outside the
// transaction (lib/immichDates.ts): a slow Immich never holds the rows.
//
// A selection is widened before anything is decided: a burst pile cut by the
// selection is taken whole (one clock shot it, and a pile must keep its
// rhythm), and a RAW+JPEG or Live Photo pair moves as one. Then only the
// bodies the human ticked move: a session usually mixes a right clock (the
// phone) with the wrong one.
import type pg from "pg";
import { pool, tx } from "./db";
import { burstExpandCTE } from "./bursts";
import { applyOwnZones, inheritNeighbourZones } from "./captureDays";
import {
  type CapturedAtSource,
  trueInstant,
  zoneAt,
  zoneOffsetMinutes,
} from "./captureZone";
import { type MatchOptions, type TrackPoint, positionAt } from "./trackParse";
import {
  type CorrectionPlan,
  type CorrectionRecord,
  type CorrectionRequest,
  type MatchCandidate,
  MAX_CORRECTION_ROWS,
  MAX_SHIFT_S,
  type MovedRow,
  type UndoReport,
  localWallMs,
  nextShift,
  parseLocalInput,
  wallIso,
} from "./captureCorrectionTypes";
import type { AuthVia } from "./auth";

type Exec = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/** A request the caller got wrong: the route answers 400 with the message. */
export class CorrectionError extends Error {}

type Row = {
  id: string | number;
  filename: string;
  device: string | null;
  session_id: string | number;
  session_name: string;
  captured_ms: string | number;
  file_ms: string | number | null;
  captured_at_source: string | null;
  capture_offset_min: number | null;
  capture_offset_source: string | null;
  capture_shift_s: number | null;
  gps_source: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  track_import_id: string | number | null;
  in_immich: boolean;
};

const ROW_COLUMNS = `a.id, a.filename, a.device, a.session_id, s.name AS session_name,
  (extract(epoch FROM a.captured_at) * 1000)::float8 AS captured_ms,
  (extract(epoch FROM a.captured_at_file) * 1000)::float8 AS file_ms,
  a.captured_at_source, a.capture_offset_min, a.capture_offset_source,
  a.capture_shift_s, a.gps_source, a.gps_lat, a.gps_lon, a.track_import_id,
  EXISTS (SELECT 1 FROM exports e
           WHERE e.source_asset_id = a.id AND e.kind = 'immich'
             AND e.output_key IS NOT NULL) AS in_immich`;

const bodyKey = (device: string | null) => device ?? "";
const wallOf = (r: Row) =>
  localWallMs(Number(r.captured_ms), r.captured_at_source, r.capture_offset_min);
const frameOf = (r: Row) => ({
  id: Number(r.id),
  filename: r.filename,
  device: r.device,
  local: wallIso(wallOf(r)),
});

async function readRows(db: Exec, ids: number[]): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `WITH ${burstExpandCTE("$1")}
     SELECT ${ROW_COLUMNS}
       FROM assets a
       JOIN sessions s ON s.id = a.session_id
      WHERE a.id IN (SELECT id FROM target_ids)
        AND a.deleted_at IS NULL AND a.purged_at IS NULL
        AND a.captured_at IS NOT NULL
      ORDER BY a.captured_at, a.id
      LIMIT ${MAX_CORRECTION_ROWS + 1}`,
    [ids],
  );
  if (rows.length > MAX_CORRECTION_ROWS)
    throw new CorrectionError(
      `This selection reaches more than ${MAX_CORRECTION_ROWS.toLocaleString("en-GB")} media: correct it in parts.`,
    );
  return rows;
}

async function readOne(db: Exec, id: number): Promise<Row | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${ROW_COLUMNS} FROM assets a JOIN sessions s ON s.id = a.session_id
      WHERE a.id = $1 AND a.deleted_at IS NULL AND a.captured_at IS NOT NULL`,
    [id],
  );
  return rows[0] ?? null;
}

type Change = {
  id: number;
  before: number | null;
  after: number | null;
  zoneSet: boolean;
  offBefore: number | null;
  offSrcBefore: string | null;
  offAfter: number | null;
  offSrcAfter: string | null;
};

type TrackItem = {
  id: number;
  importId: number;
  instantMs: number;
  lat: number | null;
  lon: number | null;
};

type Decided = {
  plan: CorrectionPlan;
  changes: Change[];
  sessionIds: number[];
  trackItems: TrackItem[];
};

function validZone(zone: string, label: string): string {
  if (zoneOffsetMinutes(zone, new Date()) == null)
    throw new CorrectionError(`${label} is not a time zone Winnow knows (${zone}).`);
  return zone;
}

/** The most common zone of the frames' own positions: what "You were in"
 * starts from in the Time zone method. */
function placeZoneOf(rows: Row[]): string | null {
  const count = new Map<string, number>();
  for (const r of rows) {
    if (r.gps_lat == null || r.gps_lon == null) continue;
    const z = zoneAt(r.gps_lat, r.gps_lon);
    if (z) count.set(z, (count.get(z) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [z, n] of count) if (best == null || n > (count.get(best) ?? 0)) best = z;
  return best;
}

function decide(req: CorrectionRequest, rows: Row[], right: Row | null): Decided {
  const ticked = req.devices == null ? null : new Set(req.devices);
  const moves = (r: Row) => ticked == null || ticked.has(bodyKey(r.device));

  // One delta for every moving frame, except a time-zone correction, whose
  // shift is decided per frame below.
  let deltaS: number | null = null;
  let pair: CorrectionPlan["pair"] = null;
  let zone: { from: string; to: string } | null = null;
  switch (req.mode) {
    case "revert":
      break;
    case "shift":
      if (req.shiftS == null || !Number.isFinite(req.shiftS))
        throw new CorrectionError("A shift needs a number of seconds.");
      deltaS = Math.round(req.shiftS);
      break;
    case "set": {
      if (!req.set) throw new CorrectionError("Setting the time needs a frame and a time.");
      const typed = parseLocalInput(req.set.local);
      if (typed == null) throw new CorrectionError("That time could not be read (YYYY-MM-DD HH:MM).");
      const ref = rows.find((r) => Number(r.id) === req.set!.id);
      if (!ref) throw new CorrectionError("The frame whose time was given is not in the selection.");
      if (!moves(ref))
        throw new CorrectionError("The frame whose time was given belongs to a body that is not ticked.");
      deltaS = Math.round((typed - wallOf(ref)) / 1000);
      break;
    }
    case "match": {
      if (!req.pair) throw new CorrectionError("Matching needs two frames of the same moment.");
      const wrong = rows.find((r) => Number(r.id) === req.pair!.wrongId);
      if (!wrong) throw new CorrectionError("The frame of the wrong clock is not in the selection.");
      if (!moves(wrong))
        throw new CorrectionError("The frame of the wrong clock belongs to a body that is not ticked.");
      if (!right) throw new CorrectionError("The frame of the right clock could not be read.");
      if (bodyKey(right.device) === bodyKey(wrong.device))
        throw new CorrectionError("Both frames come from the same camera: pick one from another body.");
      const measured = Math.round((wallOf(right) - wallOf(wrong)) / 1000);
      deltaS = req.pair.round ? Math.round(measured / 900) * 900 : measured;
      pair = { wrong: frameOf(wrong), right: frameOf(right), measuredS: measured };
      break;
    }
    case "zone":
      if (!req.zone) throw new CorrectionError("Correcting a time zone needs two zones.");
      zone = {
        from: validZone(req.zone.from, "The camera's zone"),
        to: validZone(req.zone.to, "Where you were"),
      };
      break;
  }
  if (deltaS != null && Math.abs(deltaS) > MAX_SHIFT_S)
    throw new CorrectionError("That shift is more than twenty years: check the date.");

  const bodies = new Map<string, { device: string | null; count: number; moving: boolean }>();
  const days = new Map<string, { before: number; after: number }>();
  const sessions = new Map<number, { id: number; name: string; count: number }>();
  const changes: Change[] = [];
  const trackItems: TrackItem[] = [];
  const movingRows: Array<{ r: Row; afterMs: number }> = [];
  let unchanged = 0;
  let trackPlaced = 0;
  let alreadyCorrected = 0;
  let zoneOnly = 0;
  let shifted = 0;
  let inImmich = 0;

  const bump = (date: string, key: "before" | "after") => {
    const d = days.get(date) ?? { before: 0, after: 0 };
    d[key]++;
    days.set(date, d);
  };

  for (const r of rows) {
    const k = bodyKey(r.device);
    const b = bodies.get(k) ?? { device: r.device, count: 0, moving: moves(r) };
    b.count++;
    bodies.set(k, b);
    if (!b.moving) continue;

    const captured = Number(r.captured_ms);
    const source = r.captured_at_source as CapturedAtSource | null;
    const before = r.capture_shift_s;
    let after = before;
    let zoneSet = false;
    let offAfter = r.capture_offset_min;
    let offSrcAfter = r.capture_offset_source;

    if (req.mode === "revert") {
      after = null;
      if (r.capture_offset_source === "manual") {
        zoneSet = true;
        offAfter = null;
        offSrcAfter = null;
      }
    } else if (zone) {
      zoneSet = true;
      offSrcAfter = "manual";
      if (source === "exif-wall") {
        // The wall clock read the camera's zone: move it to the place's. The
        // offsets are taken at the frame's own date (a wall time read as UTC
        // is within hours of the instant, and a DST edge is rarer than that).
        const at = new Date(captured);
        const offFrom = zoneOffsetMinutes(zone.from, at) ?? 0;
        const offTo = zoneOffsetMinutes(zone.to, at) ?? 0;
        const d = (offTo - offFrom) * 60;
        after = nextShift(before, d);
        offAfter = zoneOffsetMinutes(zone.to, new Date(captured + d * 1000 - offTo * 60000));
        if (d !== 0) shifted++;
        else zoneOnly++;
      } else {
        // The file stated its zone (or it is the mtime, an instant): the
        // moment was right, the day was filed in the wrong zone.
        offAfter = zoneOffsetMinutes(zone.to, new Date(captured));
        zoneOnly++;
      }
    } else {
      after = nextShift(before, deltaS);
    }

    const offNow = zoneSet ? offAfter : r.capture_offset_min;
    const capturedAfter = captured + ((after ?? 0) - (before ?? 0)) * 1000;
    const wallBefore = localWallMs(captured, source, r.capture_offset_min);
    const wallAfter = localWallMs(capturedAfter, source, offNow);
    bump(wallIso(wallBefore).slice(0, 10), "before");
    bump(wallIso(wallAfter).slice(0, 10), "after");

    const zoneChanged =
      zoneSet && (offAfter !== r.capture_offset_min || offSrcAfter !== r.capture_offset_source);
    if (after === before && !zoneChanged) {
      unchanged++;
      continue;
    }
    changes.push({
      id: Number(r.id),
      before,
      after,
      zoneSet: zoneChanged,
      offBefore: r.capture_offset_min,
      offSrcBefore: r.capture_offset_source,
      offAfter,
      offSrcAfter,
    });
    movingRows.push({ r, afterMs: wallAfter });
    if (before != null) alreadyCorrected++;
    if (r.in_immich) inImmich++;
    if (r.gps_source === "track" && r.track_import_id != null) {
      trackPlaced++;
      const instBefore = trueInstant(new Date(captured), source, r.capture_offset_min).getTime();
      const instAfter = trueInstant(new Date(capturedAfter), source, offNow).getTime();
      if (instAfter !== instBefore)
        trackItems.push({
          id: Number(r.id),
          importId: Number(r.track_import_id),
          instantMs: instAfter,
          lat: r.gps_lat,
          lon: r.gps_lon,
        });
    }
    const sid = Number(r.session_id);
    const s = sessions.get(sid) ?? { id: sid, name: r.session_name, count: 0 };
    s.count++;
    sessions.set(sid, s);
  }

  // Five frames spread over the moving set, first and last included.
  const picks = new Set<number>();
  if (movingRows.length) {
    const n = Math.min(5, movingRows.length);
    for (let i = 0; i < n; i++)
      picks.add(Math.round((i * (movingRows.length - 1)) / Math.max(1, n - 1)));
  }
  const samples = [...picks].map((i) => {
    const { r, afterMs } = movingRows[i];
    const fileMs = r.file_ms != null ? Number(r.file_ms) : Number(r.captured_ms);
    return {
      id: Number(r.id),
      filename: r.filename,
      device: r.device,
      before: wallIso(wallOf(r)),
      after: wallIso(afterMs),
      fileSays: wallIso(localWallMs(fileMs, r.captured_at_source, r.capture_offset_min)),
    };
  });

  // The frame "Set the time" and "Match a frame" talk about: the one named,
  // else the first the caller selected (the media open in the viewer, the
  // first ticked tile) — or, when that one's body stays put, the first frame
  // of a body that moves.
  const refId = req.set?.id ?? req.pair?.wrongId ?? req.ids[0];
  let refRow = rows.find((r) => Number(r.id) === refId) ?? null;
  if (refRow && !moves(refRow) && !req.set && !req.pair) refRow = rows.find(moves) ?? refRow;
  const reference = refRow ? { ...frameOf(refRow), moving: moves(refRow) } : null;

  return {
    plan: {
      mode: req.mode,
      reference,
      deltaS,
      zoneOnly,
      shifted,
      pair,
      candidates: [],
      placeZone: placeZoneOf(rows),
      selected: req.ids.length,
      expanded: rows.length,
      bodies: [...bodies.values()].sort((a, b) => b.count - a.count),
      moving: changes.length,
      unchanged,
      days: [...days.entries()]
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      samples,
      sessions: [...sessions.values()].sort((a, b) => b.count - a.count),
      trackPlaced,
      track: { moved: 0, same: 0, cleared: 0 },
      inImmich,
      alreadyCorrected,
    },
    changes,
    sessionIds: [...sessions.keys()],
    trackItems,
  };
}

// --- GPS track positions placed at the old moment ---------------------------

type Rematch = { id: number; before: { lat: number; lon: number } | null; after: { lat: number; lon: number } | null };

/**
 * Where each frame's own import puts it at its NEW moment, with that import's
 * own matching rule (track_imports.report.match, as the Unplaced "Follow a
 * track…" reads it). A frame the track has no fix for any more loses the
 * position: a track position IS a function of the moment, and keeping the
 * old one would keep the error the correction removes.
 */
async function rematchTrack(db: Exec, items: TrackItem[]): Promise<Rematch[]> {
  if (!items.length) return [];
  const out: Rematch[] = [];
  const byImport = new Map<number, TrackItem[]>();
  for (const it of items) byImport.set(it.importId, [...(byImport.get(it.importId) ?? []), it]);
  for (const [importId, its] of byImport) {
    const lo = Math.min(...its.map((i) => i.instantMs)) - 13 * 3600_000;
    const hi = Math.max(...its.map((i) => i.instantMs)) + 13 * 3600_000;
    const meta = await db.query<{ match: MatchOptions | null }>(
      "SELECT report->'match' AS match FROM track_imports WHERE id = $1",
      [importId],
    );
    const { rows: pts } = await db.query<{ t: string | number; lat: number; lon: number }>(
      `SELECT (extract(epoch FROM t) * 1000)::float8 AS t, lat, lon FROM track_points
        WHERE import_id = $1 AND t BETWEEN to_timestamp($2 / 1000.0) AND to_timestamp($3 / 1000.0)
        ORDER BY t`,
      [importId, lo, hi],
    );
    const points: TrackPoint[] = pts.map((p) => ({ t: Number(p.t), lat: Number(p.lat), lon: Number(p.lon) }));
    const match = meta.rows[0]?.match ?? {};
    for (const it of its) {
      const fix = positionAt(points, it.instantMs, match);
      out.push({
        id: it.id,
        before: it.lat != null && it.lon != null ? { lat: it.lat, lon: it.lon } : null,
        after: fix ? { lat: fix.lat, lon: fix.lon } : null,
      });
    }
  }
  return out;
}

const samePlace = (a: Rematch["before"], b: Rematch["after"]) =>
  a != null && b != null && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;

function countRematch(rm: Rematch[]): CorrectionPlan["track"] {
  const t = { moved: 0, same: 0, cleared: 0 };
  for (const r of rm) {
    if (r.after == null) t.cleared++;
    else if (samePlace(r.before, r.after)) t.same++;
    else t.moved++;
  }
  return t;
}

async function writePositions(
  db: Exec,
  rows: Array<{ id: number; gps: { lat: number; lon: number } | null }>,
) {
  for (const r of rows) {
    await db.query(
      `UPDATE assets SET
         gps = $2::jsonb,
         gps_source = CASE WHEN $2::jsonb IS NULL THEN NULL ELSE 'track' END,
         place_id = NULL, place_country = NULL, place_region = NULL,
         place_county = NULL, place_city = NULL, place_poi = NULL,
         geocode_status = CASE WHEN $2::jsonb IS NULL THEN 'skipped' ELSE 'pending' END,
         geocode_error = NULL, updated_at = now()
       WHERE id = $1`,
      [r.id, r.gps ? JSON.stringify({ lat: r.gps.lat, lon: r.gps.lon }) : null],
    );
  }
}

// --- Match a frame: who shot the same moment --------------------------------

let clipTable: boolean | null = null;
async function hasClip(db: Exec): Promise<boolean> {
  if (clipTable == null) {
    const { rows } = await db.query<{ ok: boolean }>(
      "SELECT to_regclass('asset_clip') IS NOT NULL AS ok",
    );
    clipTable = !!rows[0]?.ok;
  }
  return clipTable;
}

/**
 * Frames another body shot within a day either side of `wrong`, most alike
 * first: CLIP cosine similarity when both carry an embedding of the same model
 * (it sees the same scene through two lenses), else the perceptual hash, else
 * the nearest in time. The bodies that move are never offered.
 */
export async function matchCandidates(
  db: Exec,
  wrongId: number,
  movingDevices: string[] | null,
  limit = 8,
): Promise<MatchCandidate[]> {
  const clip = await hasClip(db);
  const { rows } = await db.query<{
    id: string;
    filename: string;
    device: string | null;
    captured_ms: number;
    captured_at_source: string | null;
    capture_offset_min: number | null;
    sim: number | null;
    ham: number | null;
  }>(
    `WITH w AS (
       SELECT a.id, a.device, a.captured_at, a.phash
              ${clip ? ", cl.embedding, cl.model" : ""}
         FROM assets a ${clip ? "LEFT JOIN asset_clip cl ON cl.asset_id = a.id" : ""}
        WHERE a.id = $1
     )
     SELECT c.id, c.filename, c.device,
            (extract(epoch FROM c.captured_at) * 1000)::float8 AS captured_ms,
            c.captured_at_source, c.capture_offset_min,
            ${clip ? "CASE WHEN cc.embedding IS NOT NULL THEN 1 - (cc.embedding <=> w.embedding) END" : "NULL::float8"} AS sim,
            CASE WHEN c.phash IS NOT NULL AND w.phash IS NOT NULL
                 THEN bit_count((c.phash # w.phash)::bit(64)) END AS ham
       FROM w
       JOIN assets c
         ON c.captured_at BETWEEN w.captured_at - interval '26 hours'
                              AND w.captured_at + interval '26 hours'
       ${clip ? "LEFT JOIN asset_clip cc ON cc.asset_id = c.id AND cc.model = w.model" : ""}
      WHERE c.id <> w.id AND c.deleted_at IS NULL AND c.media_type = 'photo'
        AND COALESCE(c.device, '') <> COALESCE(w.device, '')
        AND ($2::text[] IS NULL OR COALESCE(c.device, '') <> ALL($2::text[]))
      ORDER BY sim DESC NULLS LAST, ham ASC NULLS LAST,
               abs(extract(epoch FROM c.captured_at - w.captured_at))
      LIMIT $3`,
    [wrongId, movingDevices, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    filename: r.filename,
    device: r.device,
    local: wallIso(localWallMs(Number(r.captured_ms), r.captured_at_source, r.capture_offset_min)),
    similarity: r.sim == null ? null : Math.round(Number(r.sim) * 1000) / 1000,
    hamming: r.ham == null ? null : Number(r.ham),
  }));
}

function checkIds(req: CorrectionRequest) {
  if (!req.ids.length) throw new CorrectionError("Select at least one media.");
}

async function decideFor(db: Exec, req: CorrectionRequest): Promise<Decided> {
  checkIds(req);
  const rows = await readRows(db, req.ids);
  const right = req.mode === "match" && req.pair ? await readOne(db, req.pair.rightId) : null;
  return decide(req, rows, right);
}

/** What a correction would do. Reads only. */
export async function planCorrection(req: CorrectionRequest, db: Exec = pool): Promise<CorrectionPlan> {
  // "Match a frame" before a pair is chosen: the plan carries the candidates
  // and moves nothing (a zero shift).
  const pending = req.mode === "match" && !req.pair;
  const d = await decideFor(db, pending ? { ...req, mode: "shift", shiftS: 0 } : req);
  const plan = { ...d.plan, mode: req.mode };
  if (req.mode === "match") {
    const wrongId = req.pair?.wrongId ?? plan.reference?.id;
    if (wrongId != null) plan.candidates = await matchCandidates(db, wrongId, req.devices ?? null);
  }
  plan.track = countRematch(await rematchTrack(db, d.trackItems));
  return plan;
}

/** The span a session shows (captured_at_min/max) after its frames moved. */
export async function refreshSessionSpans(sessionIds: number[], db: Exec = pool): Promise<void> {
  if (!sessionIds.length) return;
  await db.query(
    `UPDATE sessions s SET captured_at_min = sub.cmin, captured_at_max = sub.cmax
       FROM (SELECT session_id, min(captured_at) AS cmin, max(captured_at) AS cmax
               FROM assets WHERE session_id = ANY($1::bigint[])
              GROUP BY session_id) sub
      WHERE s.id = sub.session_id`,
    [sessionIds],
  );
}

/** What depends on a frame's moment, recomputed after it moved. */
async function afterMove(db: pg.PoolClient, ids: number[], sessionIds: number[]): Promise<void> {
  await refreshSessionSpans(sessionIds, db);
  // A pile's printed span (bursts.started_at/ended_at, display + audit).
  await db.query(
    `UPDATE bursts b SET started_at = sub.lo, ended_at = sub.hi
       FROM (SELECT burst_id, min(captured_at) AS lo, max(captured_at) AS hi
               FROM assets
              WHERE deleted_at IS NULL AND burst_id IN (
                    SELECT burst_id FROM assets
                     WHERE id = ANY($1::bigint[]) AND burst_id IS NOT NULL)
              GROUP BY burst_id) sub
      WHERE b.id = sub.burst_id`,
    [ids],
  );
  // A frame with a position: its zone is looked up at its (new) moment —
  // except a zone a human set ('manual' outranks the position).
  await applyOwnZones(ids, db);
  // A frame that borrows its zone: the nearest donor may have changed.
  await inheritNeighbourZones({ ids, reconsider: true }, db);
}

async function writeRows(
  db: pg.PoolClient,
  rows: Array<{
    id: number;
    shift: number | null;
    correction: number | null;
    zone: boolean;
    off: number | null;
    offSrc: string | null;
  }>,
) {
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000);
    await db.query(
      `UPDATE assets a SET capture_shift_s = u.shift, capture_correction_id = u.corr,
              capture_offset_min = CASE WHEN u.zone THEN u.off ELSE a.capture_offset_min END,
              capture_offset_source = CASE WHEN u.zone THEN u.src ELSE a.capture_offset_source END,
              updated_at = now()
         FROM unnest($1::bigint[], $2::int[], $3::bigint[], $4::bool[], $5::smallint[], $6::text[])
           AS u(id, shift, corr, zone, off, src)
        WHERE a.id = u.id`,
      [
        part.map((r) => r.id),
        part.map((r) => r.shift),
        part.map((r) => r.correction),
        part.map((r) => r.zone),
        part.map((r) => r.off),
        part.map((r) => r.offSrc),
      ],
    );
  }
}

/** Apply the correction the human confirmed. One transaction. */
export async function applyCorrection(
  req: CorrectionRequest,
  who: { userId: number | null; via: AuthVia | null },
): Promise<{ id: number; plan: CorrectionPlan; ids: number[] }> {
  return tx(async (client) => {
    const { plan, changes, sessionIds, trackItems } = await decideFor(client, req);
    if (!changes.length) throw new CorrectionError("Nothing would move: no frame's time changes.");
    const rematch = await rematchTrack(client, trackItems);
    plan.track = countRematch(rematch);
    const rec = await client.query<{ id: string }>(
      `INSERT INTO capture_corrections
         (user_id, via, mode, shift_s, zone_from, zone_to, asset_count, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
      [
        who.userId,
        who.via,
        req.mode,
        plan.deltaS,
        req.mode === "zone" ? (req.zone?.from ?? null) : null,
        req.mode === "zone" ? (req.zone?.to ?? null) : null,
        changes.length,
        JSON.stringify(plan),
      ],
    );
    const id = Number(rec.rows[0].id);
    const rm = new Map(rematch.map((r) => [r.id, r]));
    for (let i = 0; i < changes.length; i += 1000) {
      const part = changes.slice(i, i + 1000);
      await client.query(
        `INSERT INTO capture_correction_assets
           (correction_id, asset_id, shift_before, shift_after, zone_set,
            offset_before, offset_source_before, offset_after, offset_source_after,
            track_rematched, gps_before, gps_after)
         SELECT $1, u.id, u.sb, u.sa, u.z, u.ob, u.osb, u.oa, u.osa, u.tr, u.gb, u.ga
           FROM unnest($2::bigint[], $3::int[], $4::int[], $5::bool[], $6::smallint[],
                       $7::text[], $8::smallint[], $9::text[], $10::bool[], $11::jsonb[], $12::jsonb[])
             AS u(id, sb, sa, z, ob, osb, oa, osa, tr, gb, ga)`,
        [
          id,
          part.map((c) => c.id),
          part.map((c) => c.before),
          part.map((c) => c.after),
          part.map((c) => c.zoneSet),
          part.map((c) => c.offBefore),
          part.map((c) => c.offSrcBefore),
          part.map((c) => c.offAfter),
          part.map((c) => c.offSrcAfter),
          part.map((c) => rm.has(c.id) && !samePlace(rm.get(c.id)!.before, rm.get(c.id)!.after)),
          part.map((c) => (rm.get(c.id)?.before ? JSON.stringify(rm.get(c.id)!.before) : null)),
          part.map((c) => (rm.get(c.id)?.after ? JSON.stringify(rm.get(c.id)!.after) : null)),
        ],
      );
    }
    await writeRows(
      client,
      changes.map((c) => ({
        id: c.id,
        shift: c.after,
        correction: id,
        zone: c.zoneSet,
        off: c.offAfter,
        offSrc: c.offSrcAfter,
      })),
    );
    await writePositions(
      client,
      rematch
        .filter((r) => !samePlace(r.before, r.after))
        .map((r) => ({ id: r.id, gps: r.after })),
    );
    const ids = changes.map((c) => c.id);
    await afterMove(client, ids, sessionIds);
    await client.query("UPDATE capture_corrections SET report = $2::jsonb WHERE id = $1", [
      id,
      JSON.stringify(plan),
    ]);
    return { id, plan, ids };
  });
}

/** Take a correction back: only on the rows it still owns. */
export async function undoCorrection(id: number): Promise<UndoReport & { ids: number[] }> {
  return tx(async (client) => {
    const rec = await client.query<{ undone_at: string | null }>(
      "SELECT undone_at FROM capture_corrections WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!rec.rows.length) throw new CorrectionError("No such correction.");
    if (rec.rows[0].undone_at) throw new CorrectionError("This correction was already undone.");

    const { rows } = await client.query<{
      asset_id: string;
      shift_before: number | null;
      session_id: string;
      previous: string | null;
      zone_back: boolean;
      offset_before: number | null;
      offset_source_before: string | null;
      gps_back: boolean;
      gps_before: { lat: number; lon: number } | null;
    }>(
      `SELECT ca.asset_id, ca.shift_before, a.session_id,
              -- The gesture that owned the row before this one, if it still
              -- stands: Undo hands the row back to it, so it can be undone too.
              (SELECT max(p.correction_id) FROM capture_correction_assets p
                 JOIN capture_corrections pc ON pc.id = p.correction_id
                WHERE p.asset_id = ca.asset_id AND p.correction_id < ca.correction_id
                  AND pc.undone_at IS NULL) AS previous,
              -- The zone and the track position go back only while they are
              -- still what this correction wrote.
              (ca.zone_set
                 AND a.capture_offset_min IS NOT DISTINCT FROM ca.offset_after
                 AND a.capture_offset_source IS NOT DISTINCT FROM ca.offset_source_after) AS zone_back,
              ca.offset_before, ca.offset_source_before,
              (ca.track_rematched AND a.gps IS NOT DISTINCT FROM ca.gps_after) AS gps_back,
              ca.gps_before
         FROM capture_correction_assets ca
         JOIN assets a ON a.id = ca.asset_id
        WHERE ca.correction_id = $1
          AND a.capture_correction_id = ca.correction_id
          AND a.capture_shift_s IS NOT DISTINCT FROM ca.shift_after`,
      [id],
    );
    const all = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM capture_correction_assets WHERE correction_id = $1",
      [id],
    );
    const report: UndoReport = {
      restored: rows.length,
      skipped: Number(all.rows[0].n) - rows.length,
    };
    await writeRows(
      client,
      rows.map((r) => ({
        id: Number(r.asset_id),
        shift: r.shift_before,
        correction: r.previous == null ? null : Number(r.previous),
        zone: r.zone_back,
        off: r.offset_before,
        offSrc: r.offset_source_before,
      })),
    );
    await writePositions(
      client,
      rows.filter((r) => r.gps_back).map((r) => ({ id: Number(r.asset_id), gps: r.gps_before })),
    );
    await client.query(
      "UPDATE capture_corrections SET undone_at = now(), undo_report = $2::jsonb WHERE id = $1",
      [id, JSON.stringify(report)],
    );
    const ids = rows.map((r) => Number(r.asset_id));
    const sessionIds = [...new Set(rows.map((r) => Number(r.session_id)))];
    if (ids.length) await afterMove(client, ids, sessionIds);
    return { ...report, ids };
  });
}

/** The corrections, newest first, for Settings › Pipeline › Dates & places. */
export async function listCorrections(limit = 50, db: Exec = pool): Promise<CorrectionRecord[]> {
  const { rows } = await db.query<Omit<CorrectionRecord, "id"> & { id: string }>(
    `SELECT c.id, c.created_at, u.username, c.via, c.mode, c.shift_s, c.zone_from,
            c.zone_to, c.asset_count, c.report, c.undone_at, c.undo_report
       FROM capture_corrections c
       LEFT JOIN users u ON u.id = c.user_id
      ORDER BY c.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Record what the push to Immich did, on the correction's report. */
export async function recordImmich(
  id: number,
  key: "immich" | "undoImmich",
  value: unknown,
  db: Exec = pool,
): Promise<void> {
  await db.query(
    `UPDATE capture_corrections SET report = jsonb_set(report, $2::text[], $3::jsonb) WHERE id = $1`,
    [id, [key], JSON.stringify(value)],
  );
}

/** The ids a correction moved ("Show media"). */
export async function correctionAssetIds(id: number, db: Exec = pool): Promise<number[]> {
  const { rows } = await db.query<{ asset_id: string }>(
    `SELECT ca.asset_id FROM capture_correction_assets ca
       JOIN assets a ON a.id = ca.asset_id AND a.deleted_at IS NULL
      WHERE ca.correction_id = $1 ORDER BY ca.asset_id`,
    [id],
  );
  return rows.map((r) => Number(r.asset_id));
}

/** How many moved rows an answer carries back for a grid to patch in place;
 * past it the client reloads its list instead. */
export const MOVED_ROWS_CAP = 5000;

/** The fields a grid patches after a correction, for these ids — or null
 * past MOVED_ROWS_CAP (the client then reloads). */
export async function movedRows(ids: number[], db: Exec = pool): Promise<MovedRow[] | null> {
  if (ids.length > MOVED_ROWS_CAP) return null;
  if (!ids.length) return [];
  const { rows } = await db.query<Omit<MovedRow, "id"> & { id: string }>(
    `SELECT id, captured_at, captured_at_file, capture_shift_s,
            capture_offset_min, capture_offset_source, gps, gps_source,
            place_city, place_country
       FROM assets WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
