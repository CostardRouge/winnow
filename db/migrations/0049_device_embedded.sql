-- The camera a clip names inside its own timed-metadata track
-- (cf. lib/djiTrack.ts, lib/deviceProbe.ts).
--
-- A DJI MP4 carries no Make/Model atom, so `device_exif` stays NULL for it and
-- the body could only be voted on (0043) or picked by hand. The clip does say
-- which camera shot it — in the first sample of its `djmd` track, which the
-- indexer's EXIF read never opens. These columns hold what that track says,
-- written by the probe and by nothing else:
--
--   embedded_device        The camera as its stills spell it (`DJI FC8482`):
--   embedded_camera_model  the same shape as `device` / `camera_model`, so a
--                          clip lands on the card its photos already built.
--   embedded_model         The product as the file names it (`DJI Mini4 Pro`).
--   embedded_serial        The aircraft's serial number — the one fact that
--                          tells two identical bodies apart.
--   embedded_probed_at     When the track was last read; NULL = never. A clip
--                          read with no track found keeps the timestamp and
--                          NULL values, so the probe does not read it again.
--
-- 'embedded' was reserved as a `device_source` value by 0043 for exactly this;
-- no CHECK changes here.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS embedded_device TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS embedded_camera_model TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS embedded_model TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS embedded_serial TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS embedded_probed_at TIMESTAMPTZ;

-- The probe's backlog: live videos whose file names no body and that were
-- never read. Small next to the table, and what the Devices tab counts.
CREATE INDEX IF NOT EXISTS assets_embedded_unprobed_idx
  ON assets (id)
  WHERE media_type = 'video'
    AND embedded_probed_at IS NULL
    AND device_exif IS NULL
    AND deleted_at IS NULL;
