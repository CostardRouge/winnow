// Burst / bracket stacks — group N DISTINCT frames shot in one quick run (same
// device, a small temporal gap) into one "pile" the culling grid can collapse,
// drill into, and cull as a unit (cf. migration 0029). A stack is ORTHOGONAL to
// the RAW+JPEG / Live-Photo pairing of lib/pairing.ts:
//
//   * pairing  ties TWO files of ONE shot → rated/exported as one logical media,
//     the rating cascading to both (a pair member is `group_role='companion'`).
//   * a stack  ties N SEPARATE shots → each a real photo; ratings stay per-frame,
//     and culling the whole pile is a DELIBERATE action (Phase 2/3), never an
//     accidental cascade.
//
// Because the two are orthogonal, clustering runs over LOGICAL media: companions
// (the RAW of a pair, the .mov of a Live Photo) are skipped, so a pair counts as
// the single frame its primary represents — and a frame can be both a pair and a
// stack member.
//
// This runs after the pairing reconcilers on each scan (so companions are already
// marked) and is idempotent + incremental: it only clusters frames not yet in a
// pile (`burst_id IS NULL`), never dissolves an existing pile, and leaves runs
// shorter than the minimum ungrouped. A whole burst normally lands in one import,
// so it is clustered in a single pass; a stray late frame simply stays standalone
// rather than retro-growing a pile — a safe, no-churn trade-off for Phase 1.
import { q, many } from "./db";
import { config } from "./config";

type Frame = {
  id: number;
  device: string | null;
  captured_at: string;
  // True when this frame opens a new pile: the gap to the previous frame exceeds
  // the threshold, the device changed, or it's the first frame in the session.
  is_break: boolean;
};

// Reconcile burst stacks for one session; returns the number of new piles created.
export async function reconcileBurstsForSession(
  sessionId: number,
): Promise<number> {
  const { gapSeconds, minFrames } = config.burst;

  // Pull the session's standalone, dated photo frames in capture order, flagging
  // each one that opens a new pile. The gap test rides the same (captured_at, id)
  // ordering the grid is keyed on. Sub-second bursts share a second → gap 0 →
  // never a break, exactly what we want (they belong together).
  const frames = await many<Frame>(
    `SELECT id, device, captured_at, is_break
     FROM (
       SELECT id, device, captured_at,
              (
                lag(captured_at) OVER w IS NULL
                OR device IS DISTINCT FROM lag(device) OVER w
                OR captured_at - lag(captured_at) OVER w
                   > make_interval(secs => $2::float8)
              ) AS is_break
       FROM assets
       WHERE session_id = $1
         AND media_type = 'photo'
         AND deleted_at IS NULL
         AND group_role IS DISTINCT FROM 'companion'
         AND burst_id IS NULL
         AND captured_at IS NOT NULL
       WINDOW w AS (ORDER BY captured_at, id)
     ) t
     ORDER BY captured_at, id`,
    [sessionId, gapSeconds],
  );

  // Split the ordered frames into clusters on each break.
  const clusters: Frame[][] = [];
  for (const f of frames) {
    if (f.is_break || clusters.length === 0) clusters.push([f]);
    else clusters[clusters.length - 1].push(f);
  }

  let created = 0;
  for (const cluster of clusters) {
    if (cluster.length < minFrames) continue; // too short to be a pile
    const ids = cluster.map((f) => f.id);
    // Two statements (not a CTE) so a transient failure on one pile never aborts
    // the whole session. The first frame is the default cover; seq is 1-based.
    const { rows } = await q<{ id: number }>(
      `INSERT INTO bursts
         (session_id, device, started_at, ended_at, cover_asset_id, member_count)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        sessionId,
        cluster[0].device,
        cluster[0].captured_at,
        cluster[cluster.length - 1].captured_at,
        ids[0],
        ids.length,
      ],
    );
    const bid = rows[0].id;
    await q(
      `UPDATE assets a
         SET burst_id = $1, burst_seq = v.seq
       FROM unnest($2::bigint[]) WITH ORDINALITY AS v(id, seq)
       WHERE a.id = v.id`,
      [bid, ids],
    );
    created++;
  }
  return created;
}
