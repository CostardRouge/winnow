// Near-duplicate clustering (Phase 1). Runs incrementally, per asset, right
// after its perceptual hash is computed — the same streaming model as the
// derivatives: a clip/burst trickles in over several scans and still clusters
// correctly without a whole-session rebuild.
//
// A cluster is a set of SEPARATE shots that look alike (a burst, a re-frame, a
// near-identical retry). Two assets join the same cluster when their pHashes are
// within HAMMING of each other; clusters merge transitively (if X looks like a
// member of cluster A and a member of cluster B, A and B become one). Scoped to
// a single session: look-alikes across unrelated shoots are not the point, and
// per-session keeps the comparison set small.
//
// Concurrency: several ML jobs of the same session can run at once
// (ML_CONCURRENCY > 1), so the read-modify-write of a session's clusters is
// serialized with a Postgres advisory lock keyed on the session. Different
// sessions never block each other.
import { pool } from "./db";
import { hammingDistance } from "./imageScore";
import { config } from "./config";

// A fixed namespace for our advisory locks (first key of the two-int form) so a
// session id (second key) can never collide with an unrelated advisory lock.
const ADVISORY_NS = 774411;

type Neighbor = {
  asset_id: number;
  phash: string | null;
  near_dup_cluster_id: number | null;
};

// Assign `assetId` (already holding `phash` in asset_analysis) to a near-dup
// cluster, creating/merging clusters as needed. Returns the cluster id it landed
// in, or null when it has no look-alike in the session. Best-effort: never
// throws into the caller (a clustering hiccup must not fail the whole ML job).
export async function assignNearDupCluster(
  assetId: number,
  sessionId: number,
  phash: string,
): Promise<number | null> {
  const threshold = config.ml.nearDupThreshold;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize cluster mutations for this session (released on COMMIT/ROLLBACK).
    // sessionId is clamped to int4 for the two-key form.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      ADVISORY_NS,
      sessionId & 0x7fffffff,
    ]);

    const { rows: candidates } = await client.query<Neighbor>(
      `SELECT aa.asset_id, aa.phash, aa.near_dup_cluster_id
         FROM asset_analysis aa
         JOIN assets a ON a.id = aa.asset_id
        WHERE a.session_id = $1
          AND a.deleted_at IS NULL
          AND a.group_role IS DISTINCT FROM 'companion'
          AND aa.asset_id <> $2
          AND aa.phash IS NOT NULL`,
      [sessionId, assetId],
    );

    const matches = candidates.filter(
      (c) => hammingDistance(phash, c.phash) <= threshold,
    );

    if (matches.length === 0) {
      // No look-alike: make sure a stale membership from a prior run is cleared
      // (re-analysis), then we're done — a singleton is not a duplicate.
      await client.query(
        "UPDATE asset_analysis SET near_dup_cluster_id = NULL WHERE asset_id = $1",
        [assetId],
      );
      await client.query("COMMIT");
      return null;
    }

    const existing = [
      ...new Set(
        matches
          .map((m) => m.near_dup_cluster_id)
          .filter((id): id is number => id != null),
      ),
    ].sort((a, b) => a - b);

    let target: number;
    if (existing.length > 0) {
      // Adopt the lowest existing cluster id; fold the others into it.
      target = existing[0];
      const others = existing.slice(1);
      if (others.length > 0) {
        await client.query(
          "UPDATE asset_analysis SET near_dup_cluster_id = $1 WHERE near_dup_cluster_id = ANY($2)",
          [target, others],
        );
        await client.query("DELETE FROM near_dup_clusters WHERE id = ANY($1)", [
          others,
        ]);
      }
    } else {
      const { rows } = await client.query<{ id: number }>(
        "INSERT INTO near_dup_clusters (session_id) VALUES ($1) RETURNING id",
        [sessionId],
      );
      target = rows[0].id;
    }

    // Pull in this asset plus every matched neighbour that wasn't already in the
    // target cluster.
    const toAssign = [
      assetId,
      ...matches
        .filter((m) => m.near_dup_cluster_id !== target)
        .map((m) => m.asset_id),
    ];
    await client.query(
      "UPDATE asset_analysis SET near_dup_cluster_id = $1 WHERE asset_id = ANY($2)",
      [target, toAssign],
    );

    await client.query("COMMIT");
    return target;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already broken */
    }
    console.warn("assignNearDupCluster:", (err as Error).message);
    return null;
  } finally {
    client.release();
  }
}
