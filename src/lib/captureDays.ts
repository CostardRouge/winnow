// Which calendar day a frame was taken on — the DATABASE half (migration 0046).
//
// lib/captureZone.ts decides an offset from what one frame knows; this module
// applies that decision to rows, in three passes every writer shares:
//
//   applyOwnZones          a frame with a position takes its place's offset;
//   inheritNeighbourZones  a frame with none takes the place offset of the
//                          nearest frame (any device) shot within hours;
//   runCaptureDayBackfill  the one-shot repair of a library indexed before
//                          0046: classify each row's time, re-read the date
//                          tags of those the database alone cannot classify,
//                          then run the two passes above.
//
// Nothing here writes to an original. captured_at is never rewritten from a
// guess — only the offset beside it — so clearing capture_offset_min restores
// the pre-0046 day exactly.
import type pg from "pg";
import { exiftool, type Tags } from "exiftool-vendored";
import { pool } from "./db";
import {
  decideOwnZone,
  type CapturedAtSource,
  type OffsetSource,
} from "./captureZone";
import { readCaptureTime } from "./extract";

type Exec = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/** How far a neighbour may be, in time, to lend its place's offset. */
export const NEIGHBOUR_WINDOW_HOURS = 12;

const BATCH = 500;

// Timestamps are read as epoch milliseconds: lib/db.ts hands timestamptz back
// as Postgres' own text, which is not a format to trust Date.parse with.
type ZoneRow = {
  id: string | number;
  captured_ms: string | number;
  captured_at_source: CapturedAtSource | null;
  mtime_ms: string | number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  gps_source: string | null;
  capture_offset_min: number | null;
  capture_offset_source: OffsetSource | null;
};

const ZONE_COLUMNS = `id,
  (extract(epoch FROM captured_at) * 1000)::float8 AS captured_ms,
  captured_at_source,
  (extract(epoch FROM file_mtime) * 1000)::float8 AS mtime_ms,
  gps_lat, gps_lon, gps_source, capture_offset_min, capture_offset_source`;

type ZoneUpdate = {
  id: number;
  offset: number | null;
  source: OffsetSource | null;
  capturedAtSource: CapturedAtSource | null;
};

async function writeZones(db: Exec, updates: ZoneUpdate[]): Promise<number> {
  if (!updates.length) return 0;
  const res = await db.query(
    `UPDATE assets a SET
       capture_offset_min = u.off,
       capture_offset_source = u.src,
       captured_at_source = COALESCE(a.captured_at_source, u.cas)
     FROM unnest($1::bigint[], $2::smallint[], $3::text[], $4::text[])
       AS u(id, off, src, cas)
     WHERE a.id = u.id`,
    [
      updates.map((u) => u.id),
      updates.map((u) => u.offset),
      updates.map((u) => u.source),
      updates.map((u) => u.capturedAtSource),
    ],
  );
  return res.rowCount ?? 0;
}

/** Decide one row's own zone; null when nothing changes. */
function ownZoneUpdate(r: ZoneRow): ZoneUpdate | null {
  // A track import placed this frame AND zoned it: the provenance stays
  // 'track' (Undo takes back exactly that), not relabelled as its own GPS.
  if (r.gps_source === "track" && r.capture_offset_source === "track") return null;
  // A position read from the file itself (gps_source NULL) was there when
  // exiftool zoned the time from it: an unclassified row holding one is an
  // instant — 'file' when the time is the mtime fallback, 'exif' otherwise.
  const fromFile = r.gps_lat != null && r.gps_source == null;
  const capturedMs = Number(r.captured_ms);
  const inferredSource: CapturedAtSource | null =
    r.captured_at_source ??
    (fromFile
      ? r.mtime_ms != null && Number(r.mtime_ms) === capturedMs
        ? "file"
        : "exif"
      : null);
  const d = decideOwnZone(
    {
      capturedAt: new Date(capturedMs),
      capturedAtSource: inferredSource,
      lat: r.gps_lat,
      lon: r.gps_lon,
      offsetMin: r.capture_offset_min,
      offsetSource: r.capture_offset_source,
    },
    { positionFromFile: fromFile },
  );
  const sourceChanged = r.captured_at_source == null && inferredSource != null;
  if (
    !sourceChanged &&
    d.offsetMin === r.capture_offset_min &&
    d.offsetSource === r.capture_offset_source
  )
    return null;
  return {
    id: Number(r.id),
    offset: d.offsetMin,
    source: d.offsetSource,
    capturedAtSource: sourceChanged ? inferredSource : null,
  };
}

/**
 * Give each positioned frame its place's offset. With `ids`, just those rows
 * (the indexer after a .SRT fix, a geotag, a track import); without, every
 * positioned live row whose offset is not yet the position's.
 */
export async function applyOwnZones(
  ids?: number[],
  db: Exec = pool,
): Promise<number> {
  let changed = 0;
  if (ids) {
    for (let i = 0; i < ids.length; i += BATCH) {
      const { rows } = await db.query<ZoneRow>(
        `SELECT ${ZONE_COLUMNS} FROM assets
          WHERE id = ANY($1::bigint[]) AND captured_at IS NOT NULL`,
        [ids.slice(i, i + BATCH)],
      );
      changed += await writeZones(
        db,
        rows.map(ownZoneUpdate).filter((u): u is ZoneUpdate => u != null),
      );
    }
    return changed;
  }
  let after = 0;
  for (;;) {
    const { rows } = await db.query<ZoneRow>(
      `SELECT ${ZONE_COLUMNS} FROM assets
        WHERE id > $1 AND deleted_at IS NULL AND captured_at IS NOT NULL
          AND gps_lat IS NOT NULL
          AND capture_offset_source IS DISTINCT FROM 'gps'
          -- IS NOT DISTINCT FROM, not '=': with a NULL gps_source a plain
          -- NOT (… = 'track' AND …) is NULL and drops every file-placed row.
          AND NOT (gps_source IS NOT DISTINCT FROM 'track'
                   AND capture_offset_source IS NOT DISTINCT FROM 'track')
        ORDER BY id LIMIT ${BATCH}`,
      [after],
    );
    if (!rows.length) break;
    after = Number(rows[rows.length - 1].id);
    changed += await writeZones(
      db,
      rows.map(ownZoneUpdate).filter((u): u is ZoneUpdate => u != null),
    );
  }
  return changed;
}

// A frame's true instant, as SQL over a row alias and the offset to assume for
// a wall clock (the row's own, or the donor's when the row has none).
const INSTANT = (alias: string, offsetExpr: string) =>
  `(CASE WHEN ${alias}.captured_at_source = 'exif-wall'
         THEN ${alias}.captured_at - make_interval(mins => ${offsetExpr})
         ELSE ${alias}.captured_at END)`;

/**
 * A frame its own file could not place takes the place offset of the nearest
 * frame shot within `windowHours`, from any device: the iPhone in the pocket
 * knows the zone the Sony forgot. Only classified rows (a wall clock's instant
 * needs the donor's offset to be computed, so the window is searched with a
 * day's slack and then checked on true instants). Never overrides a place.
 */
export async function inheritNeighbourZones(
  opts: { ids?: number[]; windowHours?: number } = {},
  db: Exec = pool,
): Promise<number> {
  const windowHours = opts.windowHours ?? NEIGHBOUR_WINDOW_HOURS;
  const slackHours = windowHours + 15; // a wall clock is at most 14 h off UTC
  const pass = async (where: string, params: unknown[]) => {
    const res = await db.query(
      `WITH cand AS (
         SELECT c.id, c.captured_at, c.captured_at_source
           FROM assets c
          WHERE ${where}
            AND c.deleted_at IS NULL AND c.captured_at IS NOT NULL
            AND c.captured_at_source IS NOT NULL
            AND (c.capture_offset_source IS NULL OR c.capture_offset_source = 'exif')
       ), pick AS (
         SELECT cand.id, nb.off, nb.gap
           FROM cand
           CROSS JOIN LATERAL (
             SELECT d.capture_offset_min AS off,
                    abs(extract(epoch FROM
                      ${INSTANT("cand", "d.capture_offset_min")} -
                      ${INSTANT("d", "d.capture_offset_min")})) AS gap
               FROM assets d
              WHERE d.capture_offset_source IN ('gps', 'track')
                AND d.deleted_at IS NULL
                AND d.captured_at BETWEEN cand.captured_at - make_interval(hours => $${params.length + 1})
                                      AND cand.captured_at + make_interval(hours => $${params.length + 1})
              ORDER BY gap
              LIMIT 1
           ) nb
          WHERE nb.gap <= $${params.length + 2} * 3600
       )
       UPDATE assets a
          SET capture_offset_min = pick.off,
              capture_offset_source = 'neighbour'
         FROM pick
        WHERE a.id = pick.id
          AND (a.capture_offset_min IS DISTINCT FROM pick.off
               OR a.capture_offset_source IS DISTINCT FROM 'neighbour')`,
      [...params, slackHours, windowHours],
    );
    return res.rowCount ?? 0;
  };

  let changed = 0;
  if (opts.ids) {
    for (let i = 0; i < opts.ids.length; i += BATCH)
      changed += await pass("c.id = ANY($1::bigint[])", [opts.ids.slice(i, i + BATCH)]);
    return changed;
  }
  // Whole library, in id ranges so one statement never holds the table.
  const { rows } = await db.query<{ max: string | null }>(
    "SELECT max(id) AS max FROM assets",
  );
  const max = Number(rows[0]?.max ?? 0);
  for (let lo = 0; lo <= max; lo += BATCH * 10)
    changed += await pass("c.id > $1 AND c.id <= $2", [lo, lo + BATCH * 10]);
  return changed;
}

export type CaptureDayStats = {
  live: number;
  /** captured_at_source NULL: indexed before 0046, not yet classified. */
  unclassified: number;
  bySource: Record<string, number>;
  byOffset: Record<string, number>;
  /** Live rows whose local day is not their UTC day — the frames 0046 moved. */
  movedFromUtcDay: number;
};

/** One scan over the live library, JIT off (docs/memory/database.md). */
export async function captureDayStats(): Promise<CaptureDayStats> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL jit = off");
    const { rows } = await client.query<{
      cas: string | null;
      cos: string | null;
      n: string;
      moved: string;
    }>(
      `SELECT captured_at_source AS cas, capture_offset_source AS cos,
              count(*) AS n,
              count(*) FILTER (
                WHERE capture_date <> (captured_at AT TIME ZONE 'UTC')::date
              ) AS moved
         FROM assets
        WHERE deleted_at IS NULL AND captured_at IS NOT NULL
        GROUP BY 1, 2`,
    );
    await client.query("COMMIT");
    const out: CaptureDayStats = {
      live: 0,
      unclassified: 0,
      bySource: {},
      byOffset: {},
      movedFromUtcDay: 0,
    };
    for (const r of rows) {
      const n = Number(r.n);
      out.live += n;
      out.movedFromUtcDay += Number(r.moved);
      if (r.cas == null) out.unclassified += n;
      out.bySource[r.cas ?? "unclassified"] = (out.bySource[r.cas ?? "unclassified"] ?? 0) + n;
      out.byOffset[r.cos ?? "none"] = (out.byOffset[r.cos ?? "none"] ?? 0) + n;
    }
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type CaptureBackfillReport = {
  apply: boolean;
  reread: boolean;
  /** The re-read's window (captured_at), when it was limited to one. */
  range: { from: string; to: string } | null;
  before: CaptureDayStats;
  after: CaptureDayStats;
  /** Rows classified from what the database already knew. */
  classifiedFromDb: number;
  /** Files whose date tags were re-read, and those that could not be. */
  reread_files: number;
  reread_failed: number;
  /** Rows whose stored captured_at differed from a fresh read of the file. */
  captured_at_changed: number;
  /** Offsets written by each pass. */
  fromPosition: number;
  fromNeighbour: number;
  /** True when a pause stopped the re-read before the end (resumable). */
  stopped: boolean;
};

export type BackfillHooks = {
  shouldStop?: () => Promise<boolean> | boolean;
  throttle?: () => Promise<void>;
  onProgress?: (p: { reread: number; failed: number }) => Promise<void> | void;
};

/** Re-read one file's date tags only (fast: no maker notes, no previews). */
async function readDateTags(absPath: string): Promise<Tags> {
  return exiftool.read(absPath, { readArgs: ["-fast2"] });
}

/**
 * The repair of a library indexed before 0046. `from`/`to` limit the RE-READ
 * to a window of capture times — a track import asks for its own span rather
 * than the whole library's headers. With `apply: false` (the
 * default the UI starts with) the database-only steps run inside a
 * transaction that is rolled back, so the report says what WOULD change; the
 * re-read, which touches the originals' headers, only ever runs on apply.
 */
export async function runCaptureDayBackfill(
  opts: { apply?: boolean; reread?: boolean; from?: string; to?: string } = {},
  hooks: BackfillHooks = {},
): Promise<CaptureBackfillReport> {
  const apply = opts.apply === true;
  const reread = apply && opts.reread === true;
  const before = await captureDayStats();
  const report: CaptureBackfillReport = {
    apply,
    reread,
    range: opts.from && opts.to ? { from: opts.from, to: opts.to } : null,
    before,
    after: before,
    classifiedFromDb: 0,
    reread_files: 0,
    reread_failed: 0,
    captured_at_changed: 0,
    fromPosition: 0,
    fromNeighbour: 0,
    stopped: false,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 1. What the database already knows: the mtime fallback is exact, and a
    //    position read from the file means exiftool zoned the time from it.
    const cls = await client.query(
      `UPDATE assets SET captured_at_source = 'file'
        WHERE captured_at_source IS NULL AND deleted_at IS NULL
          AND captured_at IS NOT NULL AND captured_at = file_mtime`,
    );
    report.classifiedFromDb += cls.rowCount ?? 0;
    // 2. Positions → offsets (classifies the file-positioned rows too).
    report.fromPosition += await applyOwnZones(undefined, client);
    const classifiedByPosition = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM assets
        WHERE deleted_at IS NULL AND captured_at IS NOT NULL
          AND captured_at_source IS NULL`,
    );
    report.classifiedFromDb =
      before.unclassified - Number(classifiedByPosition.rows[0].n);
    if (!apply) {
      // 3 (dry). Neighbours over what steps 1–2 made known, then undo it all.
      report.fromNeighbour += await inheritNeighbourZones({}, client);
      await client.query("ROLLBACK");
      return report;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // 3. The rows the database cannot classify: read their date tags again.
  if (reread) {
    let after = 0;
    outer: for (;;) {
      const { rows } = await pool.query<{
        id: string;
        abs_path: string;
        captured_ms: string | number;
        capture_offset_source: OffsetSource | null;
      }>(
        `SELECT id, abs_path,
                (extract(epoch FROM captured_at) * 1000)::float8 AS captured_ms,
                capture_offset_source FROM assets
          WHERE id > $1 AND captured_at_source IS NULL AND deleted_at IS NULL
            AND captured_at IS NOT NULL
            AND ($2::timestamptz IS NULL OR captured_at >= $2::timestamptz)
            AND ($3::timestamptz IS NULL OR captured_at <= $3::timestamptz)
          ORDER BY id LIMIT 100`,
        [after, report.range?.from ?? null, report.range?.to ?? null],
      );
      if (!rows.length) break;
      for (const r of rows) {
        after = Number(r.id);
        if (hooks.shouldStop && (await hooks.shouldStop())) {
          report.stopped = true;
          break outer;
        }
        if (hooks.throttle) await hooks.throttle();
        let t: Tags;
        try {
          t = await readDateTags(r.abs_path);
        } catch {
          report.reread_failed++;
          continue;
        }
        const c = readCaptureTime(t);
        report.reread_files++;
        // No date in the file: the stored value is the mtime fallback.
        const source: CapturedAtSource = c.captured_at ? (c.captured_at_source ?? "exif") : "file";
        const freshAt = c.captured_at ? new Date(c.captured_at) : null;
        const changedAt =
          freshAt != null &&
          Number.isFinite(freshAt.getTime()) &&
          freshAt.getTime() !== Number(r.captured_ms);
        if (changedAt) report.captured_at_changed++;
        const keepStronger =
          r.capture_offset_source != null && r.capture_offset_source !== "exif";
        await pool.query(
          `UPDATE assets SET
             captured_at = COALESCE($2::timestamptz, captured_at),
             captured_at_source = $3,
             capture_offset_min = CASE WHEN $5 THEN capture_offset_min ELSE $4::smallint END,
             capture_offset_source = CASE WHEN $5 THEN capture_offset_source
                                          WHEN $4::smallint IS NULL THEN NULL
                                          ELSE 'exif' END
           WHERE id = $1`,
          [r.id, changedAt ? c.captured_at : null, source, c.exif_offset_min, keepStronger],
        );
        if (hooks.onProgress && report.reread_files % 200 === 0)
          await hooks.onProgress({ reread: report.reread_files, failed: report.reread_failed });
      }
    }
    // Rows that now know their kind and hold a human-set or track position.
    report.fromPosition += await applyOwnZones();
  }

  // 4. Neighbours, over everything the steps above made known.
  report.fromNeighbour += await inheritNeighbourZones();
  report.after = await captureDayStats();
  return report;
}
