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
-- pgvector is OPTIONAL, and this migration NEVER fails:
--   * Where pgvector is available (the pgvector/pgvector:pg16 image the compose
--     files + CI use, or any Postgres with the extension installed), it creates
--     the extension + asset_clip, and CLIP search works.
--   * Where it is NOT (a stock postgres:16-alpine, a managed Postgres without the
--     extension), it logs a NOTICE and skips the table. Every OTHER migration and
--     the app still come up; /api/search reports itself unavailable until
--     pgvector is added (`CREATE EXTENSION vector;` then re-run migrate + a CLIP
--     back-fill). This stops one missing extension from bricking the whole
--     migrate step.
--
-- The embedding column is DIMENSION-AGNOSTIC (`vector`, not `vector(N)`):
-- different CLIP models emit different sizes (512 for ViT-B-32, 768/1152 for the
-- SigLIP family) and a bare `vector` accepts any, so swapping ML_CLIP_MODEL needs
-- no migration. The trade-off is no ANN index (an HNSW index requires a fixed
-- dimension), so search is an exact flat scan — one cosine op per analyzed row,
-- low-ms over ~100k. Add an HNSW index on a pinned dimension later if needed.

-- Try to enable pgvector; tolerate its absence so migrate never aborts here. The
-- plpgsql EXCEPTION opens a savepoint, so a caught failure doesn't poison the
-- migration's transaction.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'winnow: pgvector unavailable (%) — CLIP semantic search stays off until it is installed.', SQLERRM;
END $$;

-- Create asset_clip only when the vector type actually exists. The CREATE TABLE
-- (which references the `vector` type) is inside the taken branch only, so
-- plpgsql never parses it when the type is absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
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
    -- Availability lookups + per-model filtering stay cheap.
    CREATE INDEX IF NOT EXISTS asset_clip_model_idx ON asset_clip (model);
  ELSE
    RAISE NOTICE 'winnow: skipping asset_clip table — pgvector not installed.';
  END IF;
END $$;
