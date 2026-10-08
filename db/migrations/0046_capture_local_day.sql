-- The capture DAY is the photographer's local calendar day, not the UTC one.
--
-- 0003 materialised capture_date/year/month/day as `captured_at AT TIME ZONE
-- 'UTC'`. For a file whose EXIF carries a zone (every phone, a Sony that writes
-- OffsetTimeOriginal, any file exiftool could place by its own GPS) captured_at
-- is a true instant, so everything shot before 10:00 in Queensland — 08:00 in
-- Perth — was filed on the PREVIOUS day: measured on a year of Australian
-- captures, 12 % of a GPS track's points. Atelier's itinerary deduction and its
-- "pictures of this day" both read capture_date, so the error reached every
-- consumer that groups by day (geo ?by=day, the calendar, the facets, heat).
--
-- The fix keeps captured_at exactly as the file states it and adds an
-- interpretive layer beside it:
--
--   capture_offset_min     the UTC offset of the place the frame was taken in,
--                          AT that instant (minutes, east positive). NULL = not
--                          known, which reproduces the old UTC behaviour.
--   capture_offset_source  where that offset came from, strongest first:
--                            'gps'       the frame's own position (any
--                                        gps_source), zone looked up offline;
--                            'track'     a GPS track imported for the period
--                                        (Polarsteps, GPX — lib/trackImport.ts);
--                            'neighbour' the place offset of the nearest frame,
--                                        from any device, shot within hours;
--                            'exif'      the camera's own OffsetTimeOriginal —
--                                        the weakest: a camera left on its home
--                                        zone abroad states a wrong one.
--   captured_at_source     how captured_at was read:
--                            'exif'      a zoned EXIF time: a true instant;
--                            'exif-wall' an EXIF wall clock with no zone,
--                                        stored as if it were UTC (as since
--                                        0001): its date IS the local date and
--                                        no offset may be added to it;
--                            'file'      no EXIF date at all: the file's mtime
--                                        (a copy date, as often as not).
--                          NULL = indexed before this migration and not yet
--                          classified (lib/captureDays.ts backfills it).
--
-- Every column is optional and NULL means "as before", so this migration
-- changes no stored day by itself: the backfill job and the indexer fill the
-- offsets, and clearing them restores the old behaviour exactly. Originals are
-- never written.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS capture_offset_min    SMALLINT
    CHECK (capture_offset_min BETWEEN -840 AND 840),
  ADD COLUMN IF NOT EXISTS capture_offset_source TEXT
    CHECK (capture_offset_source IN ('gps', 'track', 'neighbour', 'exif')),
  ADD COLUMN IF NOT EXISTS captured_at_source    TEXT
    CHECK (captured_at_source IN ('exif', 'exif-wall', 'file'));

-- Same trigger function as 0003, now reading the local wall clock: the UTC
-- wall clock shifted by the place's offset — except for an 'exif-wall' time,
-- whose stored value already IS the local wall clock.
CREATE OR REPLACE FUNCTION winnow_set_capture_parts() RETURNS trigger AS $$
DECLARE
  local_ts timestamp;
BEGIN
  IF NEW.captured_at IS NULL THEN
    NEW.capture_date  := NULL;
    NEW.capture_year  := NULL;
    NEW.capture_month := NULL;
    NEW.capture_day   := NULL;
  ELSE
    local_ts := (NEW.captured_at AT TIME ZONE 'UTC')
      + CASE
          WHEN NEW.captured_at_source = 'exif-wall' THEN interval '0'
          ELSE make_interval(mins => COALESCE(NEW.capture_offset_min, 0))
        END;
    NEW.capture_date  := local_ts::date;
    NEW.capture_year  := EXTRACT(YEAR  FROM local_ts)::int;
    NEW.capture_month := EXTRACT(MONTH FROM local_ts)::int;
    NEW.capture_day   := EXTRACT(DAY   FROM local_ts)::int;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-fire on the two new inputs too, so setting an offset re-files the day.
DROP TRIGGER IF EXISTS assets_capture_parts ON assets;
CREATE TRIGGER assets_capture_parts
  BEFORE INSERT OR UPDATE OF captured_at, capture_offset_min, captured_at_source
  ON assets
  FOR EACH ROW EXECUTE FUNCTION winnow_set_capture_parts();

-- The backfill's work list: rows not yet classified. Partial, so it shrinks to
-- nothing once the library has been through the job.
CREATE INDEX IF NOT EXISTS assets_capture_unclassified_idx
  ON assets (id) WHERE captured_at_source IS NULL AND deleted_at IS NULL;

-- The neighbour pass's donor lookup: frames whose offset comes from a place,
-- searched by time within hours of a frame that has none.
CREATE INDEX IF NOT EXISTS assets_capture_place_offset_idx
  ON assets (captured_at)
  WHERE capture_offset_source IN ('gps', 'track') AND deleted_at IS NULL;
