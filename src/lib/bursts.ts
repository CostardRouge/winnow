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
//
// Grouping (temporal gap + device) never tells you WHAT kind of run it is —
// continuous shooting (action) and an exposure bracket (AEB) cluster exactly
// the same way. `bursts.kind` classifies that, once, at pile-creation time
// (never re-evaluated afterwards short of an explicit restack): see
// classifyKind below for the two-tier detection.
import { q, many } from "./db";
import { config } from "./config";

// SQL CTE expanding a set of asset ids to every LIVE frame of their burst piles,
// then to each frame's RAW/Live pair companion — so one deliberate pile action
// (pick/reject the whole stack from its cover) reaches all N shots and each
// shot's other file. This is the action-side counterpart of the grid collapse:
// same `target_ids(id)` contract as groupExpandCTE (lib/pairing.ts), compose it
// as the first WITH binding. Soft-deleted frames are never pulled in by the pile
// hop (a trashed frame stays untouched by a pile verdict); explicitly passed ids
// are kept as-is, mirroring groupExpandCTE.
export function burstExpandCTE(param: string): string {
  return `target_ids AS (
    WITH pile AS (
      SELECT a.id, a.group_id
      FROM assets a
      WHERE a.id = ANY(${param}::bigint[])
         OR (a.deleted_at IS NULL AND a.burst_id IN (
               SELECT burst_id FROM assets
               WHERE id = ANY(${param}::bigint[]) AND burst_id IS NOT NULL))
    )
    SELECT id FROM pile
    UNION
    SELECT c.id FROM assets c
    WHERE c.group_id IN (SELECT group_id FROM pile WHERE group_id IS NOT NULL)
  )`;
}

type Frame = {
  id: number;
  device: string | null;
  captured_at: string;
  // True when this frame opens a new pile: the gap to the previous frame exceeds
  // the threshold, the device changed, or it's the first frame in the session.
  is_break: boolean;
  // Two-tier bracket signal (cf. classifyKind below): the maker's explicit
  // bracket-sequence index (0 = "not bracketing", not "shot #0" — see
  // lib/extract.ts) and the EV exposure bias, both from lib/extract.ts.
  bracket_shot_number: number | null;
  exposure_compensation: number | null;
};

// Classify a pile as 'bracket' (exposure-bracketed run — AEB) or 'action'
// (plain continuous shooting), tried in this order:
//   1. Explicit signal: any frame carries a real (> 0) maker bracket index.
//   2. Fallback: the frames' EV actually spreads by more than the configured
//      epsilon — this is what catches iPhone/DJI sequences, which don't stamp
//      the maker-specific tag. Metering noise on a plain burst stays well
//      under the epsilon, so this doesn't need signal 1 to be absent first.
function classifyKind(cluster: Frame[]): "action" | "bracket" {
  if (cluster.some((f) => (f.bracket_shot_number ?? 0) > 0)) return "bracket";
  const evs = cluster
    .map((f) => f.exposure_compensation)
    .filter((v): v is number => v != null);
  if (evs.length < 2) return "action";
  const spread = Math.max(...evs) - Math.min(...evs);
  return spread > config.burst.bracketEvEpsilon ? "bracket" : "action";
}

// Re-cluster one session from scratch with the CURRENT thresholds: dissolve its
// piles, then run the normal reconciler over the whole session. This is the
// deliberate escape hatch the incremental reconciler doesn't provide — it never
// touches an existing pile, so threshold changes (BURST_GAP_SECONDS /
// BURST_MIN_FRAMES) and frames that arrived after a pile formed only take
// effect here. Safe by design: piles carry no culling state (verdicts, stars
// and tags are per-asset and survive untouched); only membership, order and
// covers are recomputed.
export async function restackSession(
  sessionId: number,
): Promise<{ dissolved: number; created: number }> {
  // Clear membership first (both columns — the FK's ON DELETE SET NULL would
  // null burst_id but leave burst_seq behind), then drop the session's piles.
  await q(
    `UPDATE assets SET burst_id = NULL, burst_seq = NULL
     WHERE session_id = $1 AND burst_id IS NOT NULL`,
    [sessionId],
  );
  const dissolved = (
    await q(`DELETE FROM bursts WHERE session_id = $1`, [sessionId])
  ).rowCount;
  const created = await reconcileBurstsForSession(sessionId);
  return { dissolved: dissolved ?? 0, created };
}

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
    `SELECT id, device, captured_at, is_break,
            bracket_shot_number, exposure_compensation
     FROM (
       SELECT id, device, captured_at, bracket_shot_number, exposure_compensation,
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
         (session_id, device, started_at, ended_at, cover_asset_id, member_count, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        sessionId,
        cluster[0].device,
        cluster[0].captured_at,
        cluster[cluster.length - 1].captured_at,
        ids[0],
        ids.length,
        classifyKind(cluster),
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
