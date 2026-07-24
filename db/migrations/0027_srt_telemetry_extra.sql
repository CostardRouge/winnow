-- DJI drone flight-log (.SRT) extra telemetry: gimbal orientation, peak ground
-- speed, and representative camera exposure (cf. lib/srt.ts).
--
-- Migration 0024 materialized the GPS fix / peak altitude / sample count a DJI
-- .SRT carries. Each cue also packs the camera's gimbal aim and — for the
-- modern bracketed firmware format — the exposure the drone shot the clip at
-- (a video container itself has no per-frame EXIF, so this is the only place
-- a DJI clip's ISO/shutter/aperture/focal length live). All NULL for xml/thm
-- companions and for any .srt we couldn't parse, exactly like the 0024 columns.
ALTER TABLE asset_sidecars
  ADD COLUMN IF NOT EXISTS gimbal_pitch  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS gimbal_yaw    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS gimbal_roll   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS max_speed     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS iso           INTEGER,
  ADD COLUMN IF NOT EXISTS shutter       TEXT,
  ADD COLUMN IF NOT EXISTS fnumber       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS focal_length  DOUBLE PRECISION;
