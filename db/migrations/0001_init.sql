-- Winnow — initial schema (see specs §5).
-- processing_state is the per-file source of truth.

CREATE TABLE IF NOT EXISTS roots (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'source' CHECK (kind IN ('source', 'finals')),
  watch       BOOLEAN NOT NULL DEFAULT true,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_id         BIGINT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  source_path     TEXT NOT NULL UNIQUE,
  device_hint     TEXT,
  captured_at_min TIMESTAMPTZ,
  captured_at_max TIMESTAMPTZ,
  asset_count     INTEGER NOT NULL DEFAULT 0,
  indexed_at      TIMESTAMPTZ,
  ignored         BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS assets (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id        BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  abs_path          TEXT NOT NULL UNIQUE,
  rel_path          TEXT NOT NULL,
  filename          TEXT NOT NULL,
  ext               TEXT NOT NULL,
  media_type        TEXT NOT NULL CHECK (media_type IN ('photo', 'video')),
  device            TEXT,
  file_size         BIGINT,
  file_mtime        TIMESTAMPTZ,
  content_hash      TEXT,
  captured_at       TIMESTAMPTZ,
  camera_model      TEXT,
  lens              TEXT,
  iso               INTEGER,
  shutter           TEXT,
  aperture          REAL,
  focal_length      REAL,
  gps               JSONB,
  width             INTEGER,
  height            INTEGER,
  duration_s        REAL,
  derivative_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (derivative_status IN ('pending','processing','ready','error','skipped')),
  derivative_error  TEXT,
  processing_state  TEXT NOT NULL DEFAULT 'unprocessed'
                    CHECK (processing_state IN ('ignored','unprocessed','triaged','exported')),
  thumb_key         TEXT,
  proxy_key         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deduplication: the same content is processed only once (see decision §12.3).
-- Partial hash (size + endpoints); collisions are unlikely and tolerated in the MVP.
CREATE UNIQUE INDEX IF NOT EXISTS assets_content_hash_uniq
  ON assets (content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS ratings (
  asset_id    BIGINT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL DEFAULT 'unrated'
              CHECK (verdict IN ('pick','reject','unrated')),
  star        SMALLINT NOT NULL DEFAULT 0 CHECK (star BETWEEN 0 AND 5),
  color_label TEXT,
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tags (
  id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id   BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  target       TEXT NOT NULL CHECK (target IN ('capture_one','web','immich')),
  filter_query JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','error')),
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  result       JSONB
);

CREATE TABLE IF NOT EXISTS exports (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  export_job_id   BIGINT REFERENCES export_jobs(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('raw_copy','web_render','immich','c1_final')),
  output_path     TEXT,
  output_key      TEXT,
  params          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Key indexes (see §5).
CREATE INDEX IF NOT EXISTS assets_session_idx        ON assets (session_id);
CREATE INDEX IF NOT EXISTS assets_derivative_idx     ON assets (derivative_status);
CREATE INDEX IF NOT EXISTS assets_processing_idx     ON assets (processing_state);
-- Cursor-based pagination: (captured_at, id).
CREATE INDEX IF NOT EXISTS assets_captured_cursor_idx ON assets (captured_at, id);
CREATE INDEX IF NOT EXISTS ratings_verdict_idx        ON ratings (verdict);
CREATE INDEX IF NOT EXISTS exports_source_idx         ON exports (source_asset_id);
