-- ML-assisted culling — Phase 0 (foundations) + Phase 1 (sharpness + near-dup).
--
-- The culling analysis lives in a SIDE table, not on the hot `assets` row, for
-- three reasons: it is entirely OPTIONAL (nullable, an asset works without it),
-- it is RECOMPUTABLE (a model/heuristic upgrade can wipe + rebuild it without a
-- destructive ALTER on the main table), and it keeps the wide `assets` row lean.
-- Mirrors the "materialized attributes" pattern (migration 0003) but in its own
-- table because, unlike capture date, these values come from a separate, slow,
-- rate-limited pass over the derivatives (NOT from the indexer).
--
-- Phase 1 fills two columns, both computed on the lightweight PROXY (never the
-- RAW — the guiding principle is "touch the RAW only once", at indexing):
--   * sharpness — variance of the Laplacian on a fixed-size greyscale render.
--                 Higher = sharper. A relative score (compare within a burst /
--                 session), NOT an absolute "good/bad" threshold: an intentional
--                 bokeh or motion blur legitimately scores low.
--   * phash     — 64-bit DCT perceptual hash, stored as 16 lowercase hex chars.
--                 Near-duplicates have a small Hamming distance. Stored as TEXT
--                 on purpose: db.ts installs a global int8->JS-number parser
--                 (pg type 20), which would silently mangle a 64-bit BIGINT past
--                 2^53. Hex round-trips losslessly.
--
-- Later phases (aesthetic score, face / closed-eye detection) add their own
-- columns here via new migrations.

CREATE TABLE IF NOT EXISTS asset_analysis (
  asset_id            BIGINT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  -- Lifecycle of the ML pass, independent of derivative_status so analysis can
  -- be paused / rate-limited / retried on its own.
  ml_status           TEXT NOT NULL DEFAULT 'pending'
                      CHECK (ml_status IN ('pending','processing','ready','error')),
  ml_error            TEXT,
  sharpness           REAL,
  phash               TEXT,
  -- Near-duplicate cluster this asset belongs to (NULL = no look-alike found).
  near_dup_cluster_id BIGINT,
  analyzed_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Near-duplicate clusters: a set of SEPARATE assets that look alike (a burst,
-- a re-frame, a near-identical retry). Deliberately NOT modelled on
-- `asset_groups`: that machinery means "these files ARE one logical media" and
-- makes them rate / delete / collapse as a single unit (groupExpandCTE, the grid
-- companion LATERAL). Near-duplicates are the opposite — distinct shots the user
-- must CHOOSE BETWEEN — so they get their own structure and never collapse a
-- grid tile or cascade a verdict.
CREATE TABLE IF NOT EXISTS near_dup_clusters (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE asset_analysis
  ADD CONSTRAINT asset_analysis_cluster_fk
  FOREIGN KEY (near_dup_cluster_id) REFERENCES near_dup_clusters(id) ON DELETE SET NULL;

-- Range filter on sharpness ("least sharp first" review); partial so the index
-- only carries analysed rows.
CREATE INDEX IF NOT EXISTS asset_analysis_sharpness_idx
  ON asset_analysis (sharpness) WHERE sharpness IS NOT NULL;
-- "Show only assets that have look-alikes" filter, and cluster membership lookups.
CREATE INDEX IF NOT EXISTS asset_analysis_cluster_idx
  ON asset_analysis (near_dup_cluster_id) WHERE near_dup_cluster_id IS NOT NULL;
-- Drives the per-session near-dup pass (scan a session's analysed phashes).
CREATE INDEX IF NOT EXISTS near_dup_clusters_session_idx
  ON near_dup_clusters (session_id);
