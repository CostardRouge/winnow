// Clocks that look wrong (docs/CAPTURE-TIME.md §7, phase 3) — SUGGESTIONS
// only: nothing here moves a frame. A suggestion opens the one correction
// dialog (app/CaptureTimeModal.tsx) pre-filled, and a human applies it or says
// "Not a mistake" (capture_clock_dismissals, migration 0062).
//
// Two kinds of evidence, both per session and per camera body:
//
//   pairs  Two bodies shot the same scenes. For a sample of one body's
//          photos, the most alike photo of another body within a day either
//          side (CLIP cosine, same model) is its twin; the gap between their
//          local times, rounded to 15 min, is what that body is off by. When
//          most twins agree on one non-zero gap, that gap is the suggestion.
//          Which of the two bodies moves: the one whose files carry the
//          fewest positions of their own — the phone in the pocket sets its
//          clock and its zone from the network, the camera does not.
//
//   track  A body whose files carry their OWN position (a Sony fed by the
//          phone app) and an imported GPS track (Polarsteps, GPX) disagree by
//          more than 25 km at the stated moments — the conflict the track
//          import already reports. The shift (whole half-hours, ±14 h) that
//          puts most of those frames back within 25 km of the track is the
//          suggestion.
//
// The thresholds are printed in the UI next to each suggestion's evidence.
import type pg from "pg";
import { pool } from "./db";
import type { CapturedAtSource } from "./captureZone";
import { trueInstant } from "./captureZone";
import { type MatchOptions, type TrackPoint, distanceKm, positionAt } from "./trackParse";
import { CONFLICT_KM } from "./trackImport";
import { type ClockSuggestion, localWallMs } from "./captureCorrectionTypes";

type Exec = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/** CLIP cosine similarity for two photos to count as the same scene. */
export const PAIR_MIN_SIMILARITY = 0.9;
/** Photos sampled per body per session (evenly through its time span). */
const PAIR_SAMPLE = 80;
/** Twins needed on one gap, and the share of a body's twins it must hold. */
export const PAIR_MIN_AGREEING = 3;
export const PAIR_MIN_SHARE = 0.6;
/** Track evidence: frames in conflict at the stated time, and the share of
 *  the frames the track covers that the best shift must put back. */
export const TRACK_MIN_CONFLICTS = 3;
export const TRACK_MIN_RESOLVED_SHARE = 0.8;
const TRACK_STEP_S = 1800;
const TRACK_MAX_S = 14 * 3600;

type Twin = { xId: number; xDev: string; xWall: number; yId: number; yDev: string; yWall: number };

/**
 * The gaps between look-alike photos of two bodies: pure, so the rule is
 * testable without embeddings. Returns one candidate per body to move.
 */
export function suggestFromTwins(
  twins: Twin[],
  ownGpsShare: Map<string, number>,
): Array<{ device: string; reference: string; shiftS: number; pairs: number; agreeing: number; example: { wrongId: number; rightId: number } }> {
  // Per ordered (moving, reference) body pair: gap → twins.
  const groups = new Map<string, Map<number, Twin[]>>();
  for (const t of twins) {
    const gap = Math.round((t.yWall - t.xWall) / 900_000) * 900; // seconds, 15-min steps
    const key = `${t.xDev}\u0000${t.yDev}`;
    const g = groups.get(key) ?? new Map<number, Twin[]>();
    g.set(gap, [...(g.get(gap) ?? []), t]);
    groups.set(key, g);
  }
  const best = new Map<string, { device: string; reference: string; shiftS: number; pairs: number; agreeing: number; example: { wrongId: number; rightId: number } }>();
  for (const [key, gaps] of groups) {
    const [x, y] = key.split("\u0000");
    let total = 0;
    let top: [number, Twin[]] | null = null;
    for (const entry of gaps) {
      total += entry[1].length;
      if (!top || entry[1].length > top[1].length) top = entry;
    }
    if (!top) continue;
    const [shiftS, agree] = top;
    if (shiftS === 0 || agree.length < PAIR_MIN_AGREEING || agree.length < PAIR_MIN_SHARE * total) continue;
    // The two directions of one disagreement are one suggestion: move the
    // body whose files know least where they are.
    const unordered = [x, y].sort().join("\u0000");
    const xShare = ownGpsShare.get(x) ?? 0;
    const yShare = ownGpsShare.get(y) ?? 0;
    const moveX = xShare < yShare || (xShare === yShare && x <= y);
    const cand = moveX
      ? { device: x, reference: y, shiftS, pairs: total, agreeing: agree.length, example: { wrongId: agree[0].xId, rightId: agree[0].yId } }
      : { device: y, reference: x, shiftS: -shiftS, pairs: total, agreeing: agree.length, example: { wrongId: agree[0].yId, rightId: agree[0].xId } };
    const prev = best.get(unordered);
    if (!prev || cand.agreeing > prev.agreeing) best.set(unordered, cand);
  }
  return [...best.values()];
}

/**
 * The shift that reconciles a body's own positions with a track: pure, for
 * the tests. `frames` are the body's frames that carry a position of their
 * own; `fixAt` answers where the track was at an instant (or null).
 */
export function suggestFromTrack(
  frames: Array<{ instantMs: number; lat: number; lon: number }>,
  fixAt: (t: number) => { lat: number; lon: number } | null,
): { shiftS: number; frames: number; conflicts: number; resolved: number } | null {
  const score = (s: number) => {
    let covered = 0;
    let ok = 0;
    for (const f of frames) {
      const fix = fixAt(f.instantMs + s * 1000);
      if (!fix) continue;
      covered++;
      if (distanceKm(fix, f) <= CONFLICT_KM) ok++;
    }
    return { covered, ok };
  };
  const zero = score(0);
  const conflicts = zero.covered - zero.ok;
  if (conflicts < TRACK_MIN_CONFLICTS) return null;
  let bestS = 0;
  let best = zero;
  for (let s = -TRACK_MAX_S; s <= TRACK_MAX_S; s += TRACK_STEP_S) {
    if (s === 0) continue;
    const sc = score(s);
    if (sc.ok > best.ok || (sc.ok === best.ok && Math.abs(s) < Math.abs(bestS))) {
      best = sc;
      bestS = s;
    }
  }
  if (bestS === 0 || best.ok < TRACK_MIN_CONFLICTS || best.ok < TRACK_MIN_RESOLVED_SHARE * best.covered)
    return null;
  return { shiftS: bestS, frames: zero.covered, conflicts, resolved: best.ok };
}

let clipTable: boolean | null = null;
async function hasClip(db: Exec): Promise<boolean> {
  if (clipTable == null) {
    const { rows } = await db.query<{ ok: boolean }>("SELECT to_regclass('asset_clip') IS NOT NULL AS ok");
    clipTable = !!rows[0]?.ok;
  }
  return clipTable;
}

async function twinsOf(db: Exec, sessionId: number): Promise<Twin[]> {
  if (!(await hasClip(db))) return [];
  const { rows } = await db.query<{
    xid: string; xdev: string; xms: number; xsrc: string | null; xoff: number | null;
    yid: string; ydev: string; yms: number; ysrc: string | null; yoff: number | null;
  }>(
    `WITH x AS MATERIALIZED (
       SELECT a.id, COALESCE(a.device, '') AS dev, a.captured_at,
              a.captured_at_source AS src, a.capture_offset_min AS off,
              cl.embedding, cl.model,
              row_number() OVER (PARTITION BY COALESCE(a.device, '') ORDER BY a.captured_at, a.id) AS rn,
              count(*) OVER (PARTITION BY COALESCE(a.device, '')) AS n
         FROM assets a
         JOIN asset_clip cl ON cl.asset_id = a.id
        WHERE a.session_id = $1 AND a.deleted_at IS NULL
          AND a.media_type = 'photo' AND a.captured_at IS NOT NULL
     )
     SELECT x.id AS xid, x.dev AS xdev,
            (extract(epoch FROM x.captured_at) * 1000)::float8 AS xms, x.src AS xsrc, x.off AS xoff,
            y.id AS yid, y.dev AS ydev, y.ms AS yms, y.src AS ysrc, y.off AS yoff
       FROM x
       CROSS JOIN LATERAL (
         SELECT z.id, z.dev, (extract(epoch FROM z.captured_at) * 1000)::float8 AS ms,
                z.src, z.off, 1 - (z.embedding <=> x.embedding) AS sim
           FROM x z
          WHERE z.dev <> x.dev AND z.model = x.model
            AND z.captured_at BETWEEN x.captured_at - interval '26 hours'
                                  AND x.captured_at + interval '26 hours'
          ORDER BY z.embedding <=> x.embedding
          LIMIT 1
       ) y
      WHERE x.rn % GREATEST(1, x.n / $2) = 0
        AND y.sim >= $3`,
    [sessionId, PAIR_SAMPLE, PAIR_MIN_SIMILARITY],
  );
  return rows.map((r) => ({
    xId: Number(r.xid),
    xDev: r.xdev,
    xWall: localWallMs(Number(r.xms), r.xsrc, r.xoff),
    yId: Number(r.yid),
    yDev: r.ydev,
    yWall: localWallMs(Number(r.yms), r.ysrc, r.yoff),
  }));
}

async function trackEvidence(db: Exec, sessionId: number) {
  const { rows: frames } = await db.query<{
    dev: string; ms: number; src: string | null; off: number | null; lat: number; lon: number;
  }>(
    `SELECT COALESCE(device, '') AS dev,
            (extract(epoch FROM captured_at) * 1000)::float8 AS ms,
            captured_at_source AS src, capture_offset_min AS off, gps_lat AS lat, gps_lon AS lon
       FROM assets
      WHERE session_id = $1 AND deleted_at IS NULL AND captured_at IS NOT NULL
        AND gps_source IS NULL AND gps_lat IS NOT NULL`,
    [sessionId],
  );
  if (frames.length < TRACK_MIN_CONFLICTS) return [];
  const lo = Math.min(...frames.map((f) => Number(f.ms))) - (TRACK_MAX_S + 13 * 3600) * 1000;
  const hi = Math.max(...frames.map((f) => Number(f.ms))) + (TRACK_MAX_S + 13 * 3600) * 1000;
  const { rows: pts } = await db.query<{ import_id: string; t: number; lat: number; lon: number }>(
    `SELECT import_id, (extract(epoch FROM t) * 1000)::float8 AS t, lat, lon FROM track_points
      WHERE t BETWEEN to_timestamp($1 / 1000.0) AND to_timestamp($2 / 1000.0)
      ORDER BY import_id, t`,
    [lo, hi],
  );
  if (!pts.length) return [];
  const imports = [...new Set(pts.map((p) => Number(p.import_id)))];
  const { rows: meta } = await db.query<{ id: string; match: MatchOptions | null }>(
    "SELECT id, report->'match' AS match FROM track_imports WHERE id = ANY($1::bigint[])",
    [imports],
  );
  const tracks = imports.map((id) => ({
    points: pts
      .filter((p) => Number(p.import_id) === id)
      .map((p): TrackPoint => ({ t: Number(p.t), lat: Number(p.lat), lon: Number(p.lon) })),
    match: meta.find((m) => Number(m.id) === id)?.match ?? {},
  }));
  const fixAt = (t: number) => {
    for (const tr of tracks) {
      const f = positionAt(tr.points, t, tr.match);
      if (f) return f;
    }
    return null;
  };
  const out: Array<{ device: string; shiftS: number; frames: number; conflicts: number; resolved: number }> = [];
  for (const dev of new Set(frames.map((f) => f.dev))) {
    const mine = frames
      .filter((f) => f.dev === dev)
      .map((f) => ({
        instantMs: trueInstant(new Date(Number(f.ms)), f.src as CapturedAtSource | null, f.off).getTime(),
        lat: Number(f.lat),
        lon: Number(f.lon),
      }));
    const s = suggestFromTrack(mine, fixAt);
    if (s) out.push({ device: dev, ...s });
  }
  return out;
}

/** Every suggestion for one session, minus the ones a human turned down. */
export async function sessionSuggestions(sessionId: number, db: Exec = pool): Promise<ClockSuggestion[]> {
  const { rows: info } = await db.query<{ name: string }>("SELECT name FROM sessions WHERE id = $1", [sessionId]);
  if (!info.length) return [];
  const { rows: bodies } = await db.query<{ dev: string; n: string; own: string }>(
    `SELECT COALESCE(device, '') AS dev, count(*) AS n,
            count(*) FILTER (WHERE gps_source IS NULL AND gps_lat IS NOT NULL) AS own
       FROM assets WHERE session_id = $1 AND deleted_at IS NULL
      GROUP BY 1`,
    [sessionId],
  );
  const media = new Map(bodies.map((b) => [b.dev, Number(b.n)]));
  const share = new Map(bodies.map((b) => [b.dev, Number(b.own) / Math.max(1, Number(b.n))]));
  const { rows: dismissed } = await db.query<{ device: string; shift_s: number }>(
    "SELECT device, shift_s FROM capture_clock_dismissals WHERE session_id = $1",
    [sessionId],
  );
  const turnedDown = (device: string, shiftS: number) =>
    dismissed.some((d) => d.device === device && Number(d.shift_s) === shiftS);

  const out: ClockSuggestion[] = [];
  const base = { sessionId, sessionName: info[0].name };
  if (bodies.length >= 2) {
    for (const c of suggestFromTwins(await twinsOf(db, sessionId), share)) {
      if (turnedDown(c.device, c.shiftS)) continue;
      out.push({
        ...base,
        device: c.device,
        media: media.get(c.device) ?? 0,
        reference: c.reference,
        shiftS: c.shiftS,
        evidence: { kind: "pairs", pairs: c.pairs, agreeing: c.agreeing, example: c.example },
      });
    }
  }
  for (const c of await trackEvidence(db, sessionId)) {
    if (turnedDown(c.device, c.shiftS)) continue;
    if (out.some((o) => o.device === c.device && o.shiftS === c.shiftS)) continue;
    out.push({
      ...base,
      device: c.device,
      media: media.get(c.device) ?? 0,
      reference: null,
      shiftS: c.shiftS,
      evidence: { kind: "track", frames: c.frames, conflicts: c.conflicts, resolved: c.resolved },
    });
  }
  return out;
}

/** Sessions the library-wide look visits, most recent first — stated in the
 *  answer, never silently: two bodies or more, or own positions overlapping
 *  an imported track. */
export const LIBRARY_SESSIONS = 60;

export async function librarySuggestions(
  db: Exec = pool,
): Promise<{ suggestions: ClockSuggestion[]; checked: number; limit: number }> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id FROM sessions s
      WHERE s.captured_at_max IS NOT NULL AND (
              (SELECT count(DISTINCT COALESCE(a.device, '')) FROM assets a
                WHERE a.session_id = s.id AND a.deleted_at IS NULL) >= 2
           OR EXISTS (SELECT 1 FROM track_points p
                       WHERE p.t BETWEEN s.captured_at_min - interval '1 day'
                                     AND s.captured_at_max + interval '1 day'))
      ORDER BY s.captured_at_max DESC
      LIMIT $1`,
    [LIBRARY_SESSIONS],
  );
  const suggestions: ClockSuggestion[] = [];
  for (const r of rows) suggestions.push(...(await sessionSuggestions(Number(r.id), db)));
  return { suggestions, checked: rows.length, limit: LIBRARY_SESSIONS };
}

/** "Not a mistake": this session, body and shift are not offered again. */
export async function dismissSuggestion(
  s: { sessionId: number; device: string; shiftS: number; userId: number | null },
  db: Exec = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO capture_clock_dismissals (session_id, device, shift_s, user_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [s.sessionId, s.device, s.shiftS, s.userId],
  );
}
