-- ML analysis (§ "Faces & text"). Sends each media's EXISTING derivative (photo
-- proxy / video poster) to a self-hosted machine-learning container — the
-- immich-machine-learning image the NAS already runs — and stores what it sees:
-- detected FACES (bounding box + recognition embedding) and the TEXT read in the
-- image (OCR). The RAWs are never re-read: the pipeline analyzes the lightweight
-- WebP derivatives it already generated, so an 80k library costs 80k small HTTP
-- calls, paced by its own queue + hourly rate (cf. lib/ml.ts).
--
-- Two-part design, mirroring 0020 (places):
--   1. `asset_faces` keeps one row per detected face: the pixel bounding box in
--      the ANALYZED image (whose dimensions are stored alongside, so the box can
--      be projected onto any other rendition) plus the 512-dim ArcFace embedding
--      the container returns. The embedding is stored now (JSONB, pgvector-ready)
--      so a future "person" clustering needs NO re-inference over the library.
--   2. The two FILTERABLE dimensions are DENORMALIZED onto `assets`
--      (`face_count`, `ocr_text`), same materialize-plain-columns pattern as
--      0003/0010/0020, so the facet/filter machinery stays fast and JOIN-free.

CREATE TABLE IF NOT EXISTS asset_faces (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id   BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  -- Detection confidence [0..1] as returned by the model (minScore-filtered
  -- upstream, but kept so a stricter threshold can be applied without re-running).
  score      REAL NOT NULL,
  -- Pixel bounding box in the analyzed derivative + that derivative's dimensions
  -- (the proxy/poster, NOT the original), so the box scales to any rendition.
  x1         INTEGER NOT NULL,
  y1         INTEGER NOT NULL,
  x2         INTEGER NOT NULL,
  y2         INTEGER NOT NULL,
  img_width  INTEGER,
  img_height INTEGER,
  -- Recognition embedding (512 floats, ArcFace/buffalo_l). JSONB float array —
  -- castable to pgvector later for person clustering (cosine distance).
  embedding  JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_faces_asset_idx ON asset_faces (asset_id);

-- Status + denormalized results on the asset. `ml_status` mirrors
-- derivative_status/geocode_status so the pipeline/UI reason about it the same way.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS ml_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (ml_status IN ('pending','processing','ready','error','skipped'));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS ml_error TEXT;
-- NULL until analyzed; 0 = analyzed, no face found. Drives the Faces facet/filter.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS face_count INTEGER;
-- Every text fragment the OCR read in the image, joined with newlines. NULL until
-- analyzed or when nothing was read. Searched by the gallery's `q=` free text.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS ocr_text TEXT;

-- Facet/filter indexes (same categorical pattern as device/place in 0003/0020).
CREATE INDEX IF NOT EXISTS assets_face_count_idx ON assets (face_count);
-- `q=` searches ocr_text alongside rel_path: same trigram GIN as migration 0010.
CREATE INDEX IF NOT EXISTS assets_ocr_text_trgm_idx
  ON assets USING gin (ocr_text gin_trgm_ops);
-- Backfill/auto enqueue scans for analyzable, not-yet-analyzed assets: a partial
-- index over exactly that set keeps the sweep cheap on an 80k library.
CREATE INDEX IF NOT EXISTS assets_ml_todo_idx
  ON assets (id) WHERE ml_status = 'pending' AND deleted_at IS NULL;
