// Reading the camera a clip names in its own metadata track, and writing it.
//
// lib/djiTrack.ts does the reading (a few KB per clip, never `-ee`); this
// module decides what the answer does to the row, and runs it over the
// backlog. Two callers:
//   - the indexer, for every new or modified video whose EXIF names no body,
//     so a clip shot after this lands on its body with nobody clicking;
//   - the `device-probe` job (Settings › Pipeline › Devices), for the clips
//     indexed before it existed. Enqueue-only: it reads originals, so it rides
//     the integrity queue at the scan's pace and under its pause, like the
//     capture-day re-read (docs/memory/pipeline.md).
//
// What the track says is the FILE speaking, so it takes the place EXIF takes
// in the indexer guard (lib/indexer.ts): it beats an attribution — the vote
// ('derived') and a hand-fill ('manual') were both guesses made because the
// file seemed silent — and yields only to a human 'override'. A clip whose own
// EXIF names a body is never probed at all.
import { many, one } from "./db";
import { probeDjiTrack, type DjiTrackInfo } from "./djiTrack";
import type { ProbeReport } from "./deviceTypes";

// The report's shape is client-safe (deviceTypes.ts): the Devices tab reads it.
export type { ProbeReport };

/** What one probe did to one row. */
export type ProbeOutcome =
  | "filled" // had no body; now carries the one its track names
  | "confirmed" // an attributed body the track agrees with
  | "corrected" // an attributed body the track contradicts — the track won
  | "overridden" // a human override, kept; the track's value recorded beside it
  | "untold" // a DJI header naming no camera this reader knows
  | "no-track"; // no DJI metadata track at all

/** The report lists this many corrections; the count above it is complete. */
export const CORRECTIONS_SHOWN = 50;

// Live videos whose own EXIF names no body and that were never read. Mirrors
// the partial index of migration 0049, so the count and the walk are cheap.
const BACKLOG = `
    a.media_type = 'video'
    AND a.embedded_probed_at IS NULL
    AND a.device_exif IS NULL
    AND a.deleted_at IS NULL
    AND a.purged_at IS NULL`;

/** Clips the probe has never read — the Devices tab's count. `sessionId`
 *  narrows it to one folder (what the tests, and a future per-folder verb,
 *  use); the tab counts the whole library. */
export async function countUnprobed(sessionId?: number): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM assets a
      WHERE ${BACKLOG} AND ($1::bigint IS NULL OR a.session_id = $1)`,
    [sessionId ?? null],
  );
  return r?.n ?? 0;
}

// The bare model to write beside a camera string: what the stills of that
// camera carry in `camera_model` (`FC8482` for `DJI FC8482`), so an attributed
// clip matches its stills on both columns. With no still to copy from, the
// string minus its first word (the maker) — the shape EXIF Make + Model has.
const modelCache = new Map<string, string | null>();
async function bareModel(camera: string): Promise<string | null> {
  if (modelCache.has(camera)) return modelCache.get(camera)!;
  const r = await one<{ m: string | null }>(
    `SELECT mode() WITHIN GROUP (ORDER BY camera_model) AS m
       FROM assets WHERE device = $1 AND device_source = 'exif'`,
    [camera],
  );
  const m = r?.m ?? (camera.split(/\s+/).slice(1).join(" ") || null);
  modelCache.set(camera, m);
  return m;
}

/**
 * Record what a clip's track says and let it decide the body. One statement,
 * reading the row's OLD values for the precedence and handing them back for
 * the report. `info` null = the clip has no DJI track: the timestamp is still
 * written so the pass does not read it again, and a body that an earlier
 * probe put there ('embedded') is withdrawn — the file no longer says it.
 */
export async function applyProbe(
  id: number,
  info: DjiTrackInfo | null,
): Promise<{ outcome: ProbeOutcome; filename: string; from: string | null; to: string | null } | null> {
  const camera = info?.camera ?? null;
  const cameraModel = camera ? await bareModel(camera) : null;
  const row = await one<{
    filename: string;
    old_device: string | null;
    old_source: string | null;
    device: string | null;
  }>(
    `WITH old AS (
       SELECT id, device, device_source FROM assets WHERE id = $1 FOR UPDATE
     )
     UPDATE assets a SET
       embedded_device = $2, embedded_camera_model = $3,
       embedded_model = $4, embedded_serial = $5,
       embedded_probed_at = now(),
       -- Precedence, in the indexer guard's order: a human override and a
       -- body the file's EXIF declares are never touched; otherwise the
       -- track names the body; a track that no longer names one withdraws
       -- the body an earlier probe wrote, and leaves any other alone.
       device = CASE WHEN a.device_source = 'override' OR a.device_exif IS NOT NULL THEN a.device
                     WHEN $2::text IS NOT NULL THEN $2
                     WHEN a.device_source = 'embedded' THEN NULL
                     ELSE a.device END,
       camera_model = CASE WHEN a.device_source = 'override' OR a.device_exif IS NOT NULL THEN a.camera_model
                           WHEN $2::text IS NOT NULL THEN $3
                           WHEN a.device_source = 'embedded' THEN NULL
                           ELSE a.camera_model END,
       device_source = CASE WHEN a.device_source = 'override' OR a.device_exif IS NOT NULL THEN a.device_source
                            WHEN $2::text IS NOT NULL THEN 'embedded'
                            WHEN a.device_source = 'embedded' THEN NULL
                            ELSE a.device_source END,
       updated_at = now()
      FROM old
     WHERE a.id = old.id
     RETURNING a.filename, old.device AS old_device, old.device_source AS old_source,
               a.device`,
    [id, camera, cameraModel, info?.model ?? null, info?.serial ?? null],
  );
  if (!row) return null;
  const base = { filename: row.filename, from: row.old_device, to: row.device };
  if (!info) return { ...base, outcome: "no-track" };
  if (!camera) return { ...base, outcome: "untold" };
  if (row.old_source === "override") return { ...base, outcome: "overridden" };
  if (!row.old_device) return { ...base, outcome: "filled" };
  return {
    ...base,
    outcome: row.old_device === camera ? "confirmed" : "corrected",
  };
}

/** Read one clip and apply it — the indexer's entry point. Never throws: a
 *  probe that fails leaves the row unprobed for the backlog pass. */
export async function probeIndexedClip(id: number, absPath: string): Promise<void> {
  try {
    await applyProbe(id, await probeDjiTrack(absPath));
  } catch (err) {
    console.warn(`[device-probe] ${absPath}:`, (err as Error).message);
  }
}

/**
 * Read every clip in the backlog, oldest id first. Resumable by construction:
 * it only ever reads rows still unprobed, so a pause, a crash or a second
 * click picks up where the last one stopped. A clip that cannot be read is
 * counted and skipped for this pass, never stamped — an unmounted share must
 * not mark a thousand clips "read, nothing found".
 */
export async function runDeviceProbe(
  scope: { sessionId?: number } = {},
  hooks: {
    shouldStop?: () => Promise<boolean>;
    throttle?: () => Promise<void>;
    onProgress?: (p: { probed: number; remaining: number }) => Promise<void>;
  } = {},
): Promise<ProbeReport> {
  const report: ProbeReport = {
    probed: 0,
    filled: 0,
    confirmed: 0,
    corrected: 0,
    overridden: 0,
    untold: 0,
    noTrack: 0,
    unreadable: 0,
    stopped: false,
    remaining: 0,
    corrections: [],
    cameras: {},
  };
  modelCache.clear();
  const total = await countUnprobed(scope.sessionId);
  let after = 0;
  for (;;) {
    const batch = await many<{ id: number; abs_path: string }>(
      `SELECT a.id, a.abs_path FROM assets a
        WHERE ${BACKLOG} AND a.id > $1
          AND ($2::bigint IS NULL OR a.session_id = $2)
        ORDER BY a.id LIMIT 200`,
      [after, scope.sessionId ?? null],
    );
    if (!batch.length) break;
    for (const { id, abs_path } of batch) {
      after = id;
      if (hooks.shouldStop && (await hooks.shouldStop())) {
        report.stopped = true;
        report.remaining = await countUnprobed(scope.sessionId);
        return report;
      }
      if (hooks.throttle) await hooks.throttle();
      let info: DjiTrackInfo | null;
      try {
        info = await probeDjiTrack(abs_path);
      } catch {
        report.unreadable++;
        continue;
      }
      const res = await applyProbe(id, info);
      if (!res) continue;
      report.probed++;
      if (info?.camera)
        report.cameras[info.camera] = (report.cameras[info.camera] ?? 0) + 1;
      switch (res.outcome) {
        case "filled": report.filled++; break;
        case "confirmed": report.confirmed++; break;
        case "overridden": report.overridden++; break;
        case "untold": report.untold++; break;
        case "no-track": report.noTrack++; break;
        case "corrected":
          report.corrected++;
          if (report.corrections.length < CORRECTIONS_SHOWN)
            report.corrections.push({ id, filename: res.filename, from: res.from, to: res.to! });
          break;
      }
      if (hooks.onProgress && report.probed % 25 === 0)
        await hooks.onProgress({
          probed: report.probed,
          remaining: Math.max(0, total - report.probed - report.unreadable),
        });
    }
  }
  report.remaining = await countUnprobed(scope.sessionId);
  return report;
}
