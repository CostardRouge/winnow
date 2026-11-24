-- Correcting a camera clock that was wrong (docs/CAPTURE-TIME.md, phase 1).
--
-- A body left on its home time, a clock set by hand, a summer-time change
-- missed: the file states a moment that is N hours off, and every day-grouped
-- screen files those media on the wrong day. 0046 cannot see it — it trusts the
-- instant and only decides which zone files the day.
--
-- The correction is a SHIFT stored beside what the file says, never a date
-- typed over it, and never written into the original (the maintainer's call
-- C1, 2026-11-24: database only). New bytes would change the partial hash —
-- the Incoming copy would stop matching its Gallery twin — and cost ~4× a
-- clip's size in NAS I/O; the mtime is the scanner's change detector.
--
--   captured_at_file   What the file says (its mtime for a 'file' row),
--                      refreshed on every index. NULL only where captured_at
--                      is NULL.
--   capture_shift_s    The human correction, seconds. NULL = none.
--   captured_at        = captured_at_file + capture_shift_s, enforced by the
--                      trigger below — so every reader (filters, the calendar,
--                      Atelier, the 0046 day) sees the corrected moment with no
--                      change of its own.
--
-- The trigger also keeps the writers that predate this migration right: a
-- statement that sets captured_at without captured_at_file speaks for the FILE
-- (the indexer, the capture-day re-read, a test fixture), so its value becomes
-- captured_at_file and the shift is re-applied on top. That is what makes a
-- correction survive a re-index instead of reverting at the next mtime change.
-- A writer that knows better sets captured_at_file itself.
--
-- captured_at_source keeps meaning "how the FILE's time was read": a shifted
-- 'exif-wall' row is still a wall clock (the day trigger adds no offset to it).
--
-- capture_corrections holds one row per Apply (what Undo keys on) and
-- capture_correction_assets the before/after shift of each row it moved, so an
-- Undo puts back exactly what it replaced — and only on rows no later gesture
-- has moved again (the same contract as a track import's Undo, 0047).

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS captured_at_file TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capture_shift_s  INTEGER;

-- Nothing is corrected yet: what the row holds is what the file said. The
-- day trigger is column-specific (UPDATE OF captured_at, …), so this backfill
-- re-files no day.
UPDATE assets SET captured_at_file = captured_at
 WHERE captured_at_file IS NULL AND captured_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS capture_corrections (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  -- Which credential made it (lib/auth.ts AuthVia), like ratings.rated_via.
  via         TEXT CHECK (via IN ('session', 'token', 'agent')),
  -- 'match' and 'zone' are phase 2 (docs/CAPTURE-TIME.md §6.3); declared now so
  -- that phase needs no CHECK surgery.
  mode        TEXT NOT NULL CHECK (mode IN ('shift', 'set', 'revert', 'match', 'zone')),
  -- The delta this gesture added to every row it moved; NULL for a revert.
  shift_s     INTEGER,
  zone_from   TEXT,
  zone_to     TEXT,
  asset_count INTEGER NOT NULL,
  -- The preview the human confirmed: days before/after, bodies, sessions.
  report      JSONB NOT NULL,
  undone_at   TIMESTAMPTZ,
  undo_report JSONB
);

CREATE TABLE IF NOT EXISTS capture_correction_assets (
  correction_id BIGINT NOT NULL REFERENCES capture_corrections(id) ON DELETE CASCADE,
  asset_id      BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  shift_before  INTEGER,
  shift_after   INTEGER,
  PRIMARY KEY (correction_id, asset_id)
);
CREATE INDEX IF NOT EXISTS capture_correction_assets_asset_idx
  ON capture_correction_assets (asset_id);

-- The gesture that last moved this row: Undo only takes back rows still its.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS capture_correction_id BIGINT
    REFERENCES capture_corrections(id) ON DELETE SET NULL;

-- One trigger function for the moment and its day, so the order is explicit:
-- the corrected moment first, then 0046's local day from it.
CREATE OR REPLACE FUNCTION winnow_set_capture_parts() RETURNS trigger AS $$
DECLARE
  local_ts timestamp;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.captured_at_file := COALESCE(NEW.captured_at_file, NEW.captured_at);
  ELSIF NEW.captured_at_file IS DISTINCT FROM OLD.captured_at_file THEN
    NULL; -- the writer said what the file says: keep it
  ELSIF NEW.captured_at IS DISTINCT FROM OLD.captured_at THEN
    -- A writer that predates 0061 set the capture time: it read the file.
    NEW.captured_at_file := NEW.captured_at;
  END IF;

  NEW.captured_at := NEW.captured_at_file
    + make_interval(secs => COALESCE(NEW.capture_shift_s, 0));

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

DROP TRIGGER IF EXISTS assets_capture_parts ON assets;
CREATE TRIGGER assets_capture_parts
  BEFORE INSERT OR UPDATE OF captured_at, captured_at_file, capture_shift_s,
                             capture_offset_min, captured_at_source
  ON assets
  FOR EACH ROW EXECUTE FUNCTION winnow_set_capture_parts();
