// Correcting a camera clock that was wrong (migration 0061, docs/CAPTURE-TIME.md).
//
// A correction is a SHIFT added to what the file says — never a date typed
// over it, never written into the original (the maintainer's call C1). The
// trigger of 0061 keeps `captured_at = captured_at_file + capture_shift_s`, so
// this module only ever writes `capture_shift_s`, and every reader (filters,
// the calendar, the capture day, Atelier) follows.
//
// The gesture is Preview → Apply → Undo, like a GPS track import (0047):
//   planCorrection()   reads only: what would move, day by day;
//   applyCorrection()  one transaction: the record, each row's before/after,
//                      the shifts, then what depends on the moment (session
//                      spans, the frames' own zones, borrowed zones);
//   undoCorrection()   puts back only the rows this gesture still owns — a
//                      row a later correction moved again is left, and counted.
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
  type CorrectionPlan,
  type CorrectionRecord,
  type CorrectionRequest,
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
  capture_shift_s: number | null;
  gps_source: string | null;
};

const bodyKey = (device: string | null) => device ?? "";

async function readRows(db: Exec, ids: number[]): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `WITH ${burstExpandCTE("$1")}
     SELECT a.id, a.filename, a.device, a.session_id, s.name AS session_name,
            (extract(epoch FROM a.captured_at) * 1000)::float8 AS captured_ms,
            (extract(epoch FROM a.captured_at_file) * 1000)::float8 AS file_ms,
            a.captured_at_source, a.capture_offset_min, a.capture_shift_s,
            a.gps_source
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

type Decided = {
  plan: CorrectionPlan;
  changes: Array<{ id: number; before: number | null; after: number | null }>;
  sessionIds: number[];
};

function decide(req: CorrectionRequest, rows: Row[]): Decided {
  const ticked = req.devices == null ? null : new Set(req.devices);
  const moves = (r: Row) => ticked == null || ticked.has(bodyKey(r.device));

  // The delta every moving frame receives.
  let deltaS: number | null;
  if (req.mode === "revert") deltaS = null;
  else if (req.mode === "shift") {
    if (req.shiftS == null || !Number.isFinite(req.shiftS))
      throw new CorrectionError("A shift needs a number of seconds.");
    deltaS = Math.round(req.shiftS);
  } else {
    if (!req.set) throw new CorrectionError("Setting the time needs a frame and a time.");
    const typed = parseLocalInput(req.set.local);
    if (typed == null) throw new CorrectionError("That time could not be read (YYYY-MM-DD HH:MM).");
    const ref = rows.find((r) => Number(r.id) === req.set!.id);
    if (!ref) throw new CorrectionError("The frame whose time was given is not in the selection.");
    if (!moves(ref))
      throw new CorrectionError("The frame whose time was given belongs to a body that is not ticked.");
    const current = localWallMs(Number(ref.captured_ms), ref.captured_at_source, ref.capture_offset_min);
    deltaS = Math.round((typed - current) / 1000);
  }
  if (deltaS != null && Math.abs(deltaS) > MAX_SHIFT_S)
    throw new CorrectionError("That shift is more than twenty years: check the date.");

  const bodies = new Map<string, { device: string | null; count: number; moving: boolean }>();
  const days = new Map<string, { before: number; after: number }>();
  const sessions = new Map<number, { id: number; name: string; count: number }>();
  const changes: Decided["changes"] = [];
  const movingRows: Array<{ r: Row; afterMs: number }> = [];
  let unchanged = 0;
  let trackPlaced = 0;
  let alreadyCorrected = 0;

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

    const before = r.capture_shift_s;
    const after = nextShift(before, deltaS);
    const wall = localWallMs(Number(r.captured_ms), r.captured_at_source, r.capture_offset_min);
    const afterWall = wall + ((after ?? 0) - (before ?? 0)) * 1000;
    bump(wallIso(wall).slice(0, 10), "before");
    bump(wallIso(afterWall).slice(0, 10), "after");
    if (after === before) {
      unchanged++;
      continue;
    }
    changes.push({ id: Number(r.id), before, after });
    movingRows.push({ r, afterMs: afterWall });
    if (r.gps_source === "track") trackPlaced++;
    if (before != null) alreadyCorrected++;
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
      before: wallIso(localWallMs(Number(r.captured_ms), r.captured_at_source, r.capture_offset_min)),
      after: wallIso(afterMs),
      fileSays: wallIso(localWallMs(fileMs, r.captured_at_source, r.capture_offset_min)),
    };
  });

  // The frame "Set the time" talks about: the one named, else the first the
  // caller selected (the media open in the viewer, the first ticked tile).
  const refId = req.set?.id ?? req.ids[0];
  const refRow = rows.find((r) => Number(r.id) === refId) ?? null;
  const reference = refRow
    ? {
        id: Number(refRow.id),
        filename: refRow.filename,
        device: refRow.device,
        local: wallIso(
          localWallMs(Number(refRow.captured_ms), refRow.captured_at_source, refRow.capture_offset_min),
        ),
        moving: moves(refRow),
      }
    : null;

  return {
    plan: {
      mode: req.mode,
      reference,
      deltaS,
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
      alreadyCorrected,
    },
    changes,
    sessionIds: [...sessions.keys()],
  };
}

function checkIds(req: CorrectionRequest) {
  if (!req.ids.length) throw new CorrectionError("Select at least one media.");
}

/** What a correction would do. Reads only. */
export async function planCorrection(req: CorrectionRequest, db: Exec = pool): Promise<CorrectionPlan> {
  checkIds(req);
  return decide(req, await readRows(db, req.ids)).plan;
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
  // A frame with a position: its zone is looked up at its (new) moment.
  await applyOwnZones(ids, db);
  // A frame that borrows its zone: the nearest donor may have changed.
  await inheritNeighbourZones({ ids, reconsider: true }, db);
}

async function writeShifts(
  db: pg.PoolClient,
  correctionId: number | null,
  rows: Array<{ id: number; shift: number | null; correction: number | null }>,
) {
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000);
    await db.query(
      `UPDATE assets a SET capture_shift_s = u.shift, capture_correction_id = u.corr,
              updated_at = now()
         FROM unnest($1::bigint[], $2::int[], $3::bigint[]) AS u(id, shift, corr)
        WHERE a.id = u.id`,
      [part.map((r) => r.id), part.map((r) => r.shift), part.map((r) => r.correction ?? correctionId)],
    );
  }
}

/** Apply the correction the human confirmed. One transaction. */
export async function applyCorrection(
  req: CorrectionRequest,
  who: { userId: number | null; via: AuthVia | null },
): Promise<{ id: number; plan: CorrectionPlan; ids: number[] }> {
  checkIds(req);
  return tx(async (client) => {
    const { plan, changes, sessionIds } = decide(req, await readRows(client, req.ids));
    if (!changes.length) throw new CorrectionError("Nothing would move: no frame's time changes.");
    const rec = await client.query<{ id: string }>(
      `INSERT INTO capture_corrections (user_id, via, mode, shift_s, asset_count, report)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [who.userId, who.via, req.mode, plan.deltaS, changes.length, JSON.stringify(plan)],
    );
    const id = Number(rec.rows[0].id);
    for (let i = 0; i < changes.length; i += 1000) {
      const part = changes.slice(i, i + 1000);
      await client.query(
        `INSERT INTO capture_correction_assets (correction_id, asset_id, shift_before, shift_after)
         SELECT $1, u.id, u.b, u.a FROM unnest($2::bigint[], $3::int[], $4::int[]) AS u(id, b, a)`,
        [id, part.map((c) => c.id), part.map((c) => c.before), part.map((c) => c.after)],
      );
    }
    await writeShifts(
      client,
      id,
      changes.map((c) => ({ id: c.id, shift: c.after, correction: null })),
    );
    const ids = changes.map((c) => c.id);
    await afterMove(client, ids, sessionIds);
    return { id, plan, ids };
  });
}

/** Take a correction back: only on the rows it still owns. */
export async function undoCorrection(id: number): Promise<UndoReport> {
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
    }>(
      `SELECT ca.asset_id, ca.shift_before, a.session_id,
              -- The gesture that owned the row before this one, if it still
              -- stands: Undo hands the row back to it, so it can be undone too.
              (SELECT max(p.correction_id) FROM capture_correction_assets p
                 JOIN capture_corrections pc ON pc.id = p.correction_id
                WHERE p.asset_id = ca.asset_id AND p.correction_id < ca.correction_id
                  AND pc.undone_at IS NULL) AS previous
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
    await writeShifts(
      client,
      null,
      rows.map((r) => ({
        id: Number(r.asset_id),
        shift: r.shift_before,
        correction: r.previous == null ? null : Number(r.previous),
      })),
    );
    await client.query(
      "UPDATE capture_corrections SET undone_at = now(), undo_report = $2::jsonb WHERE id = $1",
      [id, JSON.stringify(report)],
    );
    const ids = rows.map((r) => Number(r.asset_id));
    const sessionIds = [...new Set(rows.map((r) => Number(r.session_id)))];
    if (ids.length) await afterMove(client, ids, sessionIds);
    return report;
  });
}

/** The corrections, newest first, for Settings › Pipeline › Dates & places. */
export async function listCorrections(limit = 50, db: Exec = pool): Promise<CorrectionRecord[]> {
  const { rows } = await db.query<Omit<CorrectionRecord, "id"> & { id: string }>(
    `SELECT c.id, c.created_at, u.username, c.via, c.mode, c.shift_s, c.asset_count,
            c.report, c.undone_at, c.undo_report
       FROM capture_corrections c
       LEFT JOIN users u ON u.id = c.user_id
      ORDER BY c.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** The ids a correction moved and still owns ("Show media"). */
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
            capture_offset_min, capture_offset_source
       FROM assets WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
