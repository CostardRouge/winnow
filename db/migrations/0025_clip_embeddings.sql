-- CLIP semantic search (§ "Faces & text" follow-up). Natural-language culling:
-- "the sunset beach shots", "people laughing at a table", "close-up of a bird".
--
-- Reuses the immich-machine-learning container ALREADY driving faces + OCR
-- (lib/ml.ts): the same /predict call now also asks for a CLIP *visual*
-- embedding of the media's derivative and stores it here — so indexing costs NO
-- extra HTTP round trip and never re-reads the RAW. At search time the query
-- TEXT is embedded by the SAME model's textual head and the library is ranked by
-- cosine distance (lib/ml.ts embedText + /api/search).
--
-- Needs pgvector — the Postgres image is pgvector/pgvector:pg16 (see the compose
-- files + CI). The embedding column is DIMENSION-AGNOSTIC (`vector`, not
-- `vector(N)`): different CLIP models emit different sizes (512 for ViT-B-32,
-- 768/1152 for the SigLIP family) and a bare `vector` accepts any, so swapping
-- ML_CLIP_MODEL needs no migration. The trade-off is no ANN index (an HNSW index
-- requires a fixed dimension), so search is an exact flat scan — one cosine op
-- per analyzed row, low-ms over ~100k. Add an HNSW index on a pinned dimension
-- later if the library outgrows that.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS asset_clip (
  asset_id   BIGINT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  -- CLIP image embedding of the derivative, in cosine space (immich normalizes).
  embedding  vector NOT NULL,
  -- The model that produced it. Search filters on the current ML_CLIP_MODEL so
  -- two models' incompatible spaces are never compared (a dimension mismatch
  -- would otherwise error), and a model change can re-embed only stale rows.
  model      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Availability lookups ("does this scope have any embeddings?") and per-model
-- filtering stay cheap.
CREATE INDEX IF NOT EXISTS asset_clip_model_idx ON asset_clip (model);
