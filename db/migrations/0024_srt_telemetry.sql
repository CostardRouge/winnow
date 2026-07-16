-- DJI drone flight-log (.SRT) parsed telemetry (cf. lib/srt.ts).
--
-- A DJI .SRT sidecar (migration 0017) is stored as an opaque companion, but each
-- cue packs the frame's flight telemetry. Here we materialize the little we
-- surface today onto the sidecar row: a representative GPS fix (used to backfill
-- the clip's location when the MP4 carries no EXIF GPS — common on drones), the
-- peak altitude, and the sample count. All NULL for xml/thm companions and for
-- any .srt we couldn't parse (a non-DJI subtitle, an empty/corrupt log).
ALTER TABLE asset_sidecars
  ADD COLUMN IF NOT EXISTS gps_lat      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS gps_lon      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS max_altitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sample_count INTEGER;
