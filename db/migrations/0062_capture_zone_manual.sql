-- Camera-clock corrections, phase 2 (docs/CAPTURE-TIME.md §6.3, §7).
--
-- 1. A zone a human states. "The camera was on Paris time, I was in Brisbane":
--    a file that WROTE its zone (+01:00) had the right moment all along, so
--    the fix is the zone its day is filed in, not a shift. That zone is
--    recorded as capture_offset_source = 'manual', the strongest provenance
--    (lib/captureZone.ts RANK): the capture-day passes, a track import and a
--    re-index keep it; its own Undo or a later correction takes it back.
--
-- 2. What Undo needs to put a zone back: the offset each row had before and
--    after a correction, beside the shift 0061 already records — and the
--    position of a frame a GPS track placed at its OLD moment, which the
--    correction matches against the same track at the new one (moved, or
--    taken off when the track has no fix then).
--
-- 3. Suggestions a human turned down ("Not a mistake"), so the same session,
--    body and shift are not offered again.

DO $$
DECLARE
  found_name TEXT;
BEGIN
  SELECT conname INTO found_name
  FROM pg_constraint
  WHERE conrelid = 'assets'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%capture_offset_source%'
  LIMIT 1;

  IF found_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', found_name);
  END IF;

  ALTER TABLE assets ADD CONSTRAINT assets_capture_offset_source_check
    CHECK (capture_offset_source IN ('manual', 'gps', 'track', 'neighbour', 'exif'));
END $$;

ALTER TABLE capture_correction_assets
  ADD COLUMN IF NOT EXISTS offset_before        SMALLINT,
  ADD COLUMN IF NOT EXISTS offset_source_before TEXT,
  ADD COLUMN IF NOT EXISTS offset_after         SMALLINT,
  ADD COLUMN IF NOT EXISTS offset_source_after  TEXT,
  -- Whether this correction touched the row's zone at all: a pure shift
  -- leaves it to the capture-day passes, and Undo must too.
  ADD COLUMN IF NOT EXISTS zone_set BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gps_before JSONB,
  ADD COLUMN IF NOT EXISTS gps_after  JSONB,
  ADD COLUMN IF NOT EXISTS track_rematched BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS capture_clock_dismissals (
  session_id BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- assets.device of the body the suggestion would move; '' = no body.
  device     TEXT NOT NULL,
  shift_s    INTEGER NOT NULL,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, device, shift_s)
);
