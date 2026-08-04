// People — groups the faces lib/ml.ts detects into PERSONS (migration 0035),
// the way Immich's People page does: each face joins the person whose running-
// mean embedding it is most cosine-similar to (>= ML_PERSON_MIN_SIMILARITY), or
// founds a new person when nobody is close enough. Incremental and cheap: the
// 512-dim ArcFace embeddings are already stored per face (0021 kept them for
// exactly this), people are bounded in the hundreds, so assignment is a JS loop
// over centroids — no pgvector, no re-inference, no container round trip.
//
// Two entry points share one core:
//   * assignFacesForAsset — chained at the end of runMlJob, right after the
//     asset's faces are (re-)inserted. This is also what makes person links
//     SURVIVE re-analysis: runMlJob deletes + re-mints the face rows (their
//     person_id dies with them), and the fresh faces simply re-match against
//     the surviving centroids. Names and covers live on `people` and are never
//     touched here (a lost cover face falls back at read time).
//   * assignAllPending — the backfill sweep over every unassigned face (the
//     library analyzed before this feature shipped), batched off the partial
//     asset_faces_unassigned_idx. Pure DB work: NOT paced by mlPerHour.
//
// Concurrency: every writer takes ONE advisory xact lock. Two concurrent
// assignments would otherwise race the "nobody close enough → create person"
// branch and mint duplicate people for the same new face cluster (ML worker
// concurrency is configurable, and a backfill can run next to live analyses).
// The lock serializes writers globally; readers are never blocked.
import type pg from "pg";
import { config } from "./config";
import { many, one, tx } from "./db";

// The advisory lock key for every people writer (assignment + merge). One
// arbitrary constant, distinct from anything else in the app (Postgres advisory
// locks are a single global namespace per database).
const PEOPLE_LOCK_KEY = 793_035; // "people / migration 0035"

// Cosine similarity, tolerant of the container's unnormalized vectors. Returns
// -1 (never matches) on a dimension mismatch — embeddings from two different
// face models must not be compared, mirroring how asset_clip pins its model.
// Exported for the proximity features (picker ordering, merge suggestions).
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : -1;
}

// In-memory view of one person's matchable state during an assignment batch.
type Cluster = {
  id: number;
  centroid: number[];
  n: number;
};

type PendingFace = { id: number; embedding: number[] };

// Assign a batch of faces against the current people, inside the caller's
// locked transaction. Mutates `clusters` in place (so one batch's earlier faces
// are visible to its later ones) and writes every change back: person_id per
// face, refreshed centroids, new people. Returns how many faces were assigned.
async function assignBatch(
  client: pg.PoolClient,
  clusters: Cluster[],
  faces: PendingFace[],
): Promise<number> {
  const minSim = config.ml.person.minSimilarity;
  const touched = new Set<Cluster>();
  // face id → person id, written in one batched UPDATE at the end.
  const assignments: [number, number][] = [];

  for (const face of faces) {
    if (!Array.isArray(face.embedding) || face.embedding.length === 0) continue;

    let best: Cluster | null = null;
    let bestSim = -1;
    for (const c of clusters) {
      const sim = cosineSimilarity(face.embedding, c.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }

    if (best && bestSim >= minSim) {
      // Fold the face into the running mean: next = (centroid*n + e)/(n+1).
      // The centroid drifts toward the person's true center as faces accrue.
      const n = best.n;
      for (let i = 0; i < best.centroid.length; i++) {
        best.centroid[i] = (best.centroid[i] * n + face.embedding[i]) / (n + 1);
      }
      best.n = n + 1;
      touched.add(best);
      assignments.push([face.id, best.id]);
    } else {
      // Nobody close enough: this face founds a new person, immediately
      // matchable by the rest of the batch (bursts of one new person's faces
      // must land together, not mint one person each).
      const row = await client.query<{ id: number }>(
        `INSERT INTO people (centroid, centroid_n) VALUES ($1, 1) RETURNING id`,
        [JSON.stringify(face.embedding)],
      );
      const created: Cluster = {
        id: row.rows[0].id,
        centroid: [...face.embedding],
        n: 1,
      };
      clusters.push(created);
      assignments.push([face.id, created.id]);
    }
  }

  if (assignments.length) {
    await client.query(
      `UPDATE asset_faces f SET person_id = v.person_id
         FROM (SELECT unnest($1::bigint[]) AS id,
                      unnest($2::bigint[]) AS person_id) v
        WHERE f.id = v.id`,
      [assignments.map(([f]) => f), assignments.map(([, p]) => p)],
    );
  }
  for (const c of touched) {
    await client.query(
      `UPDATE people SET centroid = $2, centroid_n = $3, updated_at = now()
        WHERE id = $1`,
      [c.id, JSON.stringify(c.centroid), c.n],
    );
  }
  return assignments.length;
}

// The people whose centroids a batch matches against. Loaded fresh per locked
// transaction so concurrent-but-serialized writers always see each other's
// people.
async function loadClusters(client: pg.PoolClient): Promise<Cluster[]> {
  const rows = await client.query<{
    id: number;
    centroid: number[] | null;
    centroid_n: number;
  }>(`SELECT id, centroid, centroid_n FROM people WHERE centroid IS NOT NULL`);
  return rows.rows
    .filter((r) => Array.isArray(r.centroid) && r.centroid.length > 0)
    .map((r) => ({
      id: r.id,
      centroid: r.centroid as number[],
      n: Math.max(1, r.centroid_n),
    }));
}

// Unnamed people whose faces are all gone (purge, re-analysis that no longer
// sees them, merge leftovers) are noise — delete them so /people never shows an
// uncoverable empty stack. NAMED people are kept even at zero faces: the name
// is user data, and the centroid lets a re-analyzed library re-attach to it.
async function pruneEmptyPeople(client: pg.PoolClient): Promise<void> {
  await client.query(
    `DELETE FROM people p
      WHERE p.name IS NULL
        AND NOT EXISTS (SELECT 1 FROM asset_faces f WHERE f.person_id = p.id)`,
  );
}

// Assign this asset's not-yet-assigned faces to people. Called at the end of
// every ML job (the faces were just inserted) — a no-op when the asset has no
// faces or clustering already saw them. Never throws into the ML job's success
// path lightly: a failure here must not mark the analysis errored (the faces
// themselves are stored fine), so the caller wraps this in its own try/catch.
export async function assignFacesForAsset(assetId: number): Promise<number> {
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [PEOPLE_LOCK_KEY]);
    const faces = await client.query<PendingFace>(
      `SELECT id, embedding FROM asset_faces
        WHERE asset_id = $1 AND person_id IS NULL AND embedding IS NOT NULL
        ORDER BY id`,
      [assetId],
    );
    if (faces.rows.length === 0) return 0;
    const clusters = await loadClusters(client);
    const assigned = await assignBatch(client, clusters, faces.rows);
    await pruneEmptyPeople(client);
    return assigned;
  });
}

// Sweep the whole unassigned pool (partial index) in bounded batches — the
// backfill for a library analyzed before people existed, and the catch-up after
// re-enabling faces. Each batch is its own short locked transaction so a live
// per-asset assignment interleaves instead of waiting behind one long lock.
const BACKFILL_BATCH = 500;

export async function assignAllPending(
  log?: (msg: string) => void,
): Promise<number> {
  let total = 0;
  for (;;) {
    const assigned = await tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [PEOPLE_LOCK_KEY]);
      const faces = await client.query<PendingFace>(
        `SELECT id, embedding FROM asset_faces
          WHERE person_id IS NULL AND embedding IS NOT NULL
          ORDER BY id
          LIMIT ${BACKFILL_BATCH}`,
      );
      if (faces.rows.length === 0) return 0;
      const clusters = await loadClusters(client);
      return assignBatch(client, clusters, faces.rows);
    });
    if (assigned === 0) break;
    total += assigned;
    log?.(`[people] assigned ${total} faces so far…`);
  }
  await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [PEOPLE_LOCK_KEY]);
    await pruneEmptyPeople(client);
  });
  return total;
}

// Merge `sourceId` into `targetId`: the fix for the clusterer splitting one
// person across two stacks. Faces move over, the centroids fold as a weighted
// mean (so future faces match the union), the target keeps its name/cover —
// falling back to the source's when it has none — and the source disappears.
export async function mergePeople(
  targetId: number,
  sourceId: number,
): Promise<void> {
  if (targetId === sourceId) throw new Error("cannot merge a person into itself");
  await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [PEOPLE_LOCK_KEY]);
    const rows = await client.query<{
      id: number;
      name: string | null;
      cover_face_id: number | null;
      centroid: number[] | null;
      centroid_n: number;
    }>(
      `SELECT id, name, cover_face_id, centroid, centroid_n
         FROM people WHERE id = ANY($1) FOR UPDATE`,
      [[targetId, sourceId]],
    );
    const target = rows.rows.find((r) => r.id === targetId);
    const source = rows.rows.find((r) => r.id === sourceId);
    if (!target || !source) throw new Error("person not found");

    await client.query(
      `UPDATE asset_faces SET person_id = $1 WHERE person_id = $2`,
      [targetId, sourceId],
    );

    // Weighted mean of the two centroids — same dimension only (a mismatch
    // means two face models; keep the target's space untouched then).
    let centroid = target.centroid;
    let n = target.centroid_n;
    const a = target.centroid;
    const b = source.centroid;
    if (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.length > 0
    ) {
      const an = Math.max(1, target.centroid_n);
      const bn = Math.max(1, source.centroid_n);
      centroid = a.map((v, i) => (v * an + b[i] * bn) / (an + bn));
      n = an + bn;
    } else if (!Array.isArray(a) && Array.isArray(b)) {
      centroid = b;
      n = source.centroid_n;
    }

    await client.query(
      `UPDATE people SET
         name          = COALESCE(name, $2),
         cover_face_id = COALESCE(cover_face_id, $3),
         centroid      = $4,
         centroid_n    = $5,
         updated_at    = now()
       WHERE id = $1`,
      [
        targetId,
        source.name,
        source.cover_face_id,
        centroid == null ? null : JSON.stringify(centroid),
        n,
      ],
    );
    // The ON DELETE SET NULL on cover_face_id/person_id never fires here: the
    // faces moved and the cover (if adopted) now belongs to the target.
    await client.query(`DELETE FROM people WHERE id = $1`, [sourceId]);
  });
}

// Move the faces `personId` holds in the given ASSETS over to another person —
// the undo for a bad merge or a bad automatic match ("these photos are not
// her"). The unit of user intent is the photo, but the unit of truth is the
// face: for each selected asset, exactly this person's faces in it move; other
// people detected in the same photo are untouched.
//
// `targetId` null means "detach": the faces found a NEW unnamed person instead
// of joining an existing one. Deliberately NOT a bare person_id=NULL — the
// next backfill sweep would just hand unassigned faces straight back to the
// centroid they came from. A fresh person with its own centroid actually
// diverges from the source over time.
//
// Centroids move EXACTLY, not approximately: a mean is recoverable from
// (mean, n) and the moved members' sum — subtract from the source, fold into
// the target — so a repaired stack matches future faces as if the strays had
// never been there. Dimension-mismatched or missing embeddings simply don't
// contribute (guarded below), mirroring assignBatch.
export async function reassignFaces(
  personId: number,
  assetIds: number[],
  targetId: number | null,
): Promise<{ moved: number; targetId: number | null }> {
  if (targetId === personId) {
    throw new Error("cannot move faces onto the same person");
  }
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [PEOPLE_LOCK_KEY]);

    const faces = await client.query<{ id: number; embedding: number[] | null }>(
      `SELECT id, embedding FROM asset_faces
        WHERE person_id = $1 AND asset_id = ANY($2)`,
      [personId, assetIds],
    );
    if (faces.rows.length === 0) return { moved: 0, targetId: null };

    const rows = await client.query<{
      id: number;
      centroid: number[] | null;
      centroid_n: number;
    }>(
      `SELECT id, centroid, centroid_n FROM people
        WHERE id = ANY($1) FOR UPDATE`,
      [targetId == null ? [personId] : [personId, targetId]],
    );
    const source = rows.rows.find((r) => r.id === personId);
    if (!source) throw new Error("person not found");
    if (targetId != null && !rows.rows.some((r) => r.id === targetId)) {
      throw new Error("person not found");
    }

    // Sum of the moved embeddings (the dimension the source centroid uses).
    const dim = Array.isArray(source.centroid) ? source.centroid.length : 0;
    let sum: number[] | null = dim ? new Array<number>(dim).fill(0) : null;
    let k = 0;
    for (const f of faces.rows) {
      if (!Array.isArray(f.embedding) || f.embedding.length === 0) continue;
      if (sum === null) sum = new Array<number>(f.embedding.length).fill(0);
      if (f.embedding.length !== sum.length) continue;
      for (let i = 0; i < sum.length; i++) sum[i] += f.embedding[i];
      k++;
    }

    // The destination: an existing person, or a fresh unnamed one born from
    // exactly the moved faces.
    let destId = targetId;
    if (destId == null) {
      const born = await client.query<{ id: number }>(
        `INSERT INTO people (centroid, centroid_n) VALUES ($1, $2) RETURNING id`,
        [sum && k ? JSON.stringify(sum.map((v) => v / k)) : null, k],
      );
      destId = born.rows[0].id;
    } else if (sum && k) {
      const target = rows.rows.find((r) => r.id === destId)!;
      const t = target.centroid;
      if (Array.isArray(t) && t.length === sum.length) {
        const tn = Math.max(1, target.centroid_n);
        const folded = t.map((v, i) => (v * tn + sum![i]) / (tn + k));
        await client.query(
          `UPDATE people SET centroid=$2, centroid_n=$3, updated_at=now() WHERE id=$1`,
          [destId, JSON.stringify(folded), tn + k],
        );
      } else if (!Array.isArray(t)) {
        await client.query(
          `UPDATE people SET centroid=$2, centroid_n=$3, updated_at=now() WHERE id=$1`,
          [destId, JSON.stringify(sum.map((v) => v / k)), k],
        );
      }
    }

    await client.query(
      `UPDATE asset_faces SET person_id = $1 WHERE id = ANY($2)`,
      [destId, faces.rows.map((f) => f.id)],
    );

    // Un-mix the source mean. When every embedded face left (n <= k), the
    // centroid is meaningless — clear it rather than divide toward noise.
    if (sum && k && Array.isArray(source.centroid)) {
      const n = Math.max(1, source.centroid_n);
      if (n - k >= 1) {
        const c = source.centroid.map((v, i) => (v * n - sum![i]) / (n - k));
        await client.query(
          `UPDATE people SET centroid=$2, centroid_n=$3, updated_at=now() WHERE id=$1`,
          [personId, JSON.stringify(c), n - k],
        );
      } else {
        await client.query(
          `UPDATE people SET centroid=NULL, centroid_n=0, updated_at=now() WHERE id=$1`,
          [personId],
        );
      }
    }

    await pruneEmptyPeople(client);
    return { moved: faces.rows.length, targetId: destId };
  });
}

// Pairs of visible people whose centroids sit just below the assignment
// threshold — the clusterer's near-misses, almost always one real person split
// in two (different lighting, glasses on/off, years apart). Surfaced on
// /people as merge SUGGESTIONS: proposed, never auto-applied — a human clicks
// each merge.
//
// The pair scan is O(n²·512) and a library's long tail of one-face strangers
// makes n large, so this is engineered to never hurt the page it serves:
//   * MEMOIZED on a cheap fingerprint of the people table — every mutation
//     that can change a suggestion also bumps a row's updated_at or the row
//     count (assign/merge/rename/hide/prune), so an unchanged fingerprint
//     returns the cached pairs with no centroid load and no math at all.
//     Repeat /people visits (the common case) cost ~one tiny query.
//   * COLD RUNS pre-normalize each centroid once into a unit Float64Array
//     (each pair is then a bare dot product), and the outer loop yields the
//     event loop every few rows — Node is single-threaded, and an unyielding
//     scan would stall the people list and every face-crop request the page
//     fires alongside (exactly the "shelf got slow" regression this fixes).
const SUGGESTION_MARGIN = 0.1; // how far below the assignment threshold to look
const SUGGESTION_FLOOR = 0.3; // never suggest below this — noise territory
const SUGGESTION_YIELD_ROWS = 64; // outer-loop rows between event-loop yields

type SuggestionPair = { a: number; b: number; similarity: number };
let suggestionCache: { fingerprint: string; pairs: SuggestionPair[] } | null =
  null;

// Unit-normalize into a Float64Array; null for a degenerate (zero) vector.
function unitVector(v: number[]): Float64Array | null {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export async function suggestMerges(limit = 20): Promise<SuggestionPair[]> {
  // Fingerprint before anything heavy: count catches inserts/prunes, the max
  // updated_at catches every in-place change (centroid drift, merge, rename,
  // hide). Per-process cache — a second app replica just recomputes once.
  const fp = await one<{ n: number; ts: string | null }>(
    `SELECT count(*)::int AS n, max(updated_at)::text AS ts FROM people`,
  );
  const fingerprint = `${fp?.n ?? 0}:${fp?.ts ?? ""}`;
  if (suggestionCache?.fingerprint === fingerprint) {
    return suggestionCache.pairs.slice(0, limit);
  }

  const rows = await many<{ id: number; centroid: number[] | null }>(
    `SELECT id, centroid FROM people
      WHERE NOT hidden AND centroid IS NOT NULL
      ORDER BY id`,
  );
  // Normalize once; pairs whose dimensions differ (two face models) are
  // skipped in the scan, mirroring cosineSimilarity's -1.
  const people: { id: number; unit: Float64Array }[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.centroid) || r.centroid.length === 0) continue;
    const unit = unitVector(r.centroid);
    if (unit) people.push({ id: r.id, unit });
  }

  const threshold = Math.max(
    SUGGESTION_FLOOR,
    config.ml.person.minSimilarity - SUGGESTION_MARGIN,
  );
  const pairs: SuggestionPair[] = [];
  for (let i = 0; i < people.length; i++) {
    // Let queued requests (the people list, face crops) interleave with the
    // scan instead of starving behind it until the whole triangle is done.
    if (i > 0 && i % SUGGESTION_YIELD_ROWS === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const a = people[i].unit;
    for (let j = i + 1; j < people.length; j++) {
      const b = people[j].unit;
      if (a.length !== b.length) continue;
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
      if (dot >= threshold) {
        pairs.push({ a: people[i].id, b: people[j].id, similarity: dot });
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  // Cache the full sorted set (it's small — threshold-filtered), sliced per
  // caller so different limits share one computation.
  suggestionCache = { fingerprint, pairs };
  return pairs.slice(0, limit);
}

// How much of the face pool is clustered — the /people header line and the
// pipeline Faces & text page. `unassigned` is what a "Group into people"
// backfill would process.
export async function peopleCoverage(): Promise<{
  people: number;
  assigned: number;
  unassigned: number;
}> {
  const rows = await many<{ people: number; assigned: number; unassigned: number }>(
    `SELECT
       (SELECT count(*) FROM people)                                AS people,
       (SELECT count(*) FROM asset_faces WHERE person_id IS NOT NULL) AS assigned,
       (SELECT count(*) FROM asset_faces
         WHERE person_id IS NULL AND embedding IS NOT NULL)          AS unassigned`,
  );
  return rows[0] ?? { people: 0, assigned: 0, unassigned: 0 };
}
