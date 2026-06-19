-- Scan (indexing) failure log. Derivative failures already live on assets
-- (derivative_status='error' + derivative_error) and import failures in
-- import_batches.result; only per-file indexing failures were persisted
-- nowhere. We record them here so they can be LISTED and RETRIED from the UI.
-- Key = absolute path (upsert: a file that fails repeatedly updates the same row
-- instead of accumulating).
CREATE TABLE IF NOT EXISTS scan_failures (
  abs_path    TEXT PRIMARY KEY,
  root_id     BIGINT REFERENCES roots(id) ON DELETE CASCADE,
  error       TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS scan_failures_open_idx
  ON scan_failures (updated_at DESC) WHERE resolved_at IS NULL;
