-- Correcting a camera body the FILE got wrong (cf. lib/deviceAttribution.ts).
--
-- Until now an attribution could only fill a hole: `assets.device` is re-read
-- from the file on every re-index and the file always won, so overwriting a
-- real EXIF value would have reverted the next time the file's mtime changed.
-- That made a wrong Make/Model (a borrowed body that kept its owner's name, a
-- phone app that stamps a generic model, a re-encode that rewrote the atoms)
-- impossible to fix.
--
--   device_source      Gains a fifth value, 'override': a human REPLACED what
--                      the file declares. It is the one provenance that beats
--                      the file at re-index (lib/indexer.ts), and only a human
--                      sets it. 'manual' keeps its meaning — a hole a human
--                      filled — and still yields to a file that later names a
--                      body.
--   device_exif        What the file itself declares, refreshed on every
--   camera_model_exif  index, whatever the provenance of `device`. It is what
--                      makes an override honest: the viewer prints "file says
--                      X", and "Revert to the file" has something to restore.
--                      NULL where the file names nothing (a DJI MP4).
--
-- Not written into the original. A corrected body lives in Winnow only: Make
-- and Model are the camera's identity inside a RAW's maker notes and an MP4's
-- atoms, rewriting them is exactly the kind of change to an original the
-- README forbids, and nothing outside Winnow groups on them the way /gear does.
--
-- Same drop-whatever-CHECK-mentions-the-column-then-recreate idiom as 0042 and
-- 0047: 0043 declared the CHECK inline, so its name is Postgres's to choose.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS device_exif TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS camera_model_exif TEXT;

-- Rows whose body came from their own file: that value IS what the file says.
-- NULL provenance means "indexed before 0043", which could only be EXIF too.
-- Attributed rows ('derived' / 'manual' / 'embedded') filled a hole, so their
-- file declares nothing and the new columns rightly stay NULL.
UPDATE assets
   SET device_exif = device,
       camera_model_exif = camera_model
 WHERE device IS NOT NULL
   AND (device_source = 'exif' OR device_source IS NULL)
   AND device_exif IS NULL;

DO $$
DECLARE
  found_name TEXT;
BEGIN
  SELECT conname INTO found_name
  FROM pg_constraint
  WHERE conrelid = 'assets'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%device_source%'
  LIMIT 1;

  IF found_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', found_name);
  END IF;

  ALTER TABLE assets ADD CONSTRAINT assets_device_source_check
    CHECK (device_source IN ('exif', 'derived', 'manual', 'embedded', 'override'));
END $$;
