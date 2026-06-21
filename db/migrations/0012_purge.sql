-- Reclaim space — the end of the "winnowing" (Winnow = to winnow/vanner).
-- Soft-delete (0007) is the *recycle bin*: `deleted_at` hides an asset but the
-- original on the NAS is untouched, so it is fully recoverable AND still takes up
-- space. Purge is the second, deliberate stage: it physically removes the
-- original + its cached derivatives to actually free the disk. It only ever acts
-- on already soft-deleted assets and is irreversible, so the UI gates it behind
-- an explicit confirmation.
--
-- The asset *row* is kept after a purge (audit + export lineage): `purged_at`
-- marks "the bytes are gone" while `deleted_at` keeps it hidden everywhere.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS purged_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_error TEXT;

-- Trash = soft-deleted but not yet purged. Hot path for the Trash view and for
-- the purge worker's selection, so keep it cheap with a partial index.
CREATE INDEX IF NOT EXISTS assets_trash_idx
  ON assets (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- Purge jobs: queued like exports, run by the worker (bounded concurrency to
-- spare the NAS HDD). `result` holds the freed bytes + per-file errors.
CREATE TABLE IF NOT EXISTS purge_jobs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filter_query JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','error')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  result       JSONB
);

-- Audit log: what was actually freed, when, and what failed (e.g. EROFS on a
-- read-only mount). Survives the asset row (ON DELETE SET NULL) so the history
-- of reclaimed space stays intact.
CREATE TABLE IF NOT EXISTS purge_log (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id  BIGINT REFERENCES assets(id) ON DELETE SET NULL,
  abs_path  TEXT NOT NULL,
  file_size BIGINT,
  status    TEXT NOT NULL CHECK (status IN ('purged','error')),
  error     TEXT,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
