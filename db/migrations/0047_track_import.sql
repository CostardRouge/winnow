-- A GPS track imported for a period — a Polarsteps export, a GPX — places the
-- frames that have no position of their own, by their capture instant, and
-- tells the capture day which zone they were in (lib/trackImport.ts).
--
--   gps_source       Gains a fourth value, 'track': the position of the
--                    imported track at the frame's instant (interpolated
--                    between two fixes, or the nearest fix within minutes).
--                    Trusted like a camera fix for a day's position (a track
--                    is a measurement, not a folder-scale guess), but NEVER
--                    written into the original: a re-index keeps it through
--                    the indexer guard, exactly like 'inferred' (0042).
--   track_imports    One row per APPLIED import: its name, kind, span and the
--                    report the human confirmed. Rows exist only by that
--                    gesture and are removed by its Undo — tens of rows, no
--                    automatic writer, hence no janitor.
--   assets.track_import_id
--                    The import that placed or zoned this frame, so Undo can
--                    take back exactly what it wrote and nothing else.
--
-- Same drop-whatever-CHECK-mentions-gps_source-then-recreate idiom as 0042, for
-- the same reason (the 0031 CHECK was auto-named).

CREATE TABLE IF NOT EXISTS track_imports (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('polarsteps', 'gpx', 'json')),
  span_start  TIMESTAMPTZ NOT NULL,
  span_end    TIMESTAMPTZ NOT NULL,
  point_count INTEGER NOT NULL,
  report      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS track_import_id BIGINT
    REFERENCES track_imports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS assets_track_import_idx
  ON assets (track_import_id) WHERE track_import_id IS NOT NULL;

DO $$
DECLARE
  found_name TEXT;
BEGIN
  SELECT conname INTO found_name
  FROM pg_constraint
  WHERE conrelid = 'assets'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%gps_source%'
  LIMIT 1;

  IF found_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', found_name);
  END IF;

  ALTER TABLE assets ADD CONSTRAINT assets_gps_source_check
    CHECK (gps_source IN ('manual', 'inferred', 'track'));
END $$;
