-- Manual geotagging (cf. lib/exifWrite.ts, api/assets/geotag). Three columns:
--
--   gps_source        'manual' when a human set the coordinates through the
--                     geotag action; NULL when they came from the file itself
--                     (EXIF) or a telemetry sidecar (.SRT). Drives the "manual"
--                     badge and lets the recap UI tell a hand-set position from
--                     a camera fix.
--   gps_write_status  Tracks the write-back of the coordinates into the
--                     ORIGINAL file's EXIF (the async gpswrite job). Same enum
--                     as derivative_status / geocode_status. Default 'skipped':
--                     nothing to write for camera-tagged media — only the
--                     manual geotag action arms it to 'pending'.
--   gps_write_error   Last write-back failure (read-only mount, exotic
--                     format…), for the pipeline failure triage.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS gps_source TEXT
  CHECK (gps_source IN ('manual'));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS gps_write_status TEXT NOT NULL
  DEFAULT 'skipped'
  CHECK (gps_write_status IN ('pending','processing','ready','error','skipped'));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS gps_write_error TEXT;
