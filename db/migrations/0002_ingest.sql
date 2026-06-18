-- Ingest / import : l'inbox est un nouveau type de root.
ALTER TABLE roots DROP CONSTRAINT IF EXISTS roots_kind_check;
ALTER TABLE roots
  ADD CONSTRAINT roots_kind_check
  CHECK (kind IN ('source', 'finals', 'inbox'));

-- Provenance des imports (quel lot, quelle origine) — utile pour le suivi.
CREATE TABLE IF NOT EXISTS import_batches (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_dir  TEXT NOT NULL,
  origin      TEXT,                      -- 'web_upload' | 'card_offload' | 'inbox' | 'ftp'
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','error')),
  imported    INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  result      JSONB
);
