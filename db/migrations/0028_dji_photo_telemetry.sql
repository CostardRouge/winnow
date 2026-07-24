-- DJI drone telemetry embedded in a still's own EXIF/XMP (drone-dji:* tags),
-- cf. lib/extract.ts. Unlike video (a per-clip .SRT sidecar, migrations
-- 0017/0024/0027), a DJI photo carries its gimbal orientation and altitude
-- directly in the file — no companion involved. NULL on every non-DJI asset.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS gimbal_pitch      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS gimbal_yaw        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS gimbal_roll       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS relative_altitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS absolute_altitude DOUBLE PRECISION;
