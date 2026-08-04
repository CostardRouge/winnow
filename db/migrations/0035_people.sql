-- People (§ "Faces & text" follow-up). Groups the faces migration 0021 already
-- detects into PERSONS — the layer Immich calls "People": every detected face
-- belongs to (at most) one person, each person shows as one stack on /people
-- with a cover face and an occurrence count, can be named, and filters the
-- gallery ("show me every media with this person").
--
-- The recognition embeddings stored per face (asset_faces.embedding, 512-dim
-- ArcFace) were kept for exactly this: clustering needs NO re-inference over
-- the library (cf. 0021's header). The clustering itself is incremental
-- centroid assignment in lib/people.ts — new faces are compared against each
-- person's running-mean embedding (people are bounded in the hundreds, so the
-- comparison is cheap JS; no pgvector needed, which stays optional here).
--
-- Durability across re-analysis: runMlJob DELETEs + re-INSERTs an asset's
-- asset_faces wholesale (cf. lib/ml.ts), so face→person links for that asset
-- die with the rows and are re-derived by re-matching the fresh faces against
-- the surviving centroids. What must outlive that churn lives on `people`:
-- the name and the centroid. The cover REFERENCE dies with its face row
-- (ON DELETE SET NULL) and the reader falls back to the person's best face.

CREATE TABLE IF NOT EXISTS people (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL until the user names the person ("Unnamed" in the UI). Not unique:
  -- two people can legitimately share a name until the user merges them.
  name          TEXT,
  -- The face whose crop fronts the stack. SET NULL (not CASCADE) because face
  -- rows are re-minted on every re-analysis: losing the chosen crop must never
  -- delete the person. NULL → the API serves the highest-score face instead.
  cover_face_id BIGINT REFERENCES asset_faces(id) ON DELETE SET NULL,
  -- Running mean of the member embeddings (JSONB float array, same encoding as
  -- asset_faces.embedding) + how many faces it averages — so assignment is
  -- incremental: next = (centroid*n + embedding)/(n+1). Never NULL in practice
  -- (a person is born from its first face), but tolerated for safety.
  centroid      JSONB,
  centroid_n    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Face → person link. SET NULL so deleting a person (merge) can never take
-- media rows down with it; orphaned faces just return to the unassigned pool.
ALTER TABLE asset_faces ADD COLUMN IF NOT EXISTS person_id
  BIGINT REFERENCES people(id) ON DELETE SET NULL;

-- The person filter (EXISTS over asset_faces) and every per-person count/cover
-- lookup key on person_id.
CREATE INDEX IF NOT EXISTS asset_faces_person_idx ON asset_faces (person_id);

-- The assignment sweep (backfill + per-asset catch-up) scans exactly the
-- faces that still need a person and can get one (an embedding exists): a
-- partial index keeps that sweep cheap however large the library grows —
-- same pattern as assets_ml_todo_idx in 0021.
CREATE INDEX IF NOT EXISTS asset_faces_unassigned_idx
  ON asset_faces (id) WHERE person_id IS NULL AND embedding IS NOT NULL;
