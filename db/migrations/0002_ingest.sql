-- Ingest / import: the inbox is a new kind of root.
ALTER TABLE roots DROP CONSTRAINT IF EXISTS roots_kind_check;
ALTER TABLE roots
  ADD CONSTRAINT roots_kind_check
  CHECK (kind IN ('source', 'finals', 'inbox'));

-- Import provenance (which batch, which origin) — useful for tracking.
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
