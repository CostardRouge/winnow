-- Sony video sidecars (companion files for video).
--
-- Sony cameras write a small metadata companion next to every video clip
-- (C0001.MP4 → C0001M01.XML — the non-real-time metadata: real capture time,
-- GPS, recording mode, codec…); other cameras drop a per-clip thumbnail
-- (C0001.THM). These are NOT media — never indexed as their own assets, never
-- given derivatives — but they must travel WITH their video through import,
-- export and purge. One row per sidecar file, tied to its video asset, mirroring
-- the "carry the companion" model of RAW+JPEG pairing (migration 0013).

CREATE TABLE IF NOT EXISTS asset_sidecars (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id    BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  abs_path    TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('xml','thm')),
  file_size   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_sidecars_asset_idx ON asset_sidecars (asset_id);
-- One row per physical file: re-indexing a clip upserts rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS asset_sidecars_abs_path_idx ON asset_sidecars (abs_path);

-- Export lineage can now record a copied sidecar alongside the raw_copy of its
-- video. Widen the existing kind CHECK to admit 'sidecar'.
ALTER TABLE exports DROP CONSTRAINT IF EXISTS exports_kind_check;
ALTER TABLE exports ADD CONSTRAINT exports_kind_check
  CHECK (kind IN ('raw_copy','web_render','immich','c1_final','sidecar'));
