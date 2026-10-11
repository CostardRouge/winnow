-- Two answers a human can give for a medium whose file names no camera, beside
-- picking one the library already knows (cf. lib/deviceAttribution.ts):
--
--   device_source 'named'  A camera the library has no file for, named by hand:
--                          "Emeric's camera", "the wedding photographer", "a
--                          Sony, unknown". The name goes in `device` itself —
--                          the gear dimension's grouping key — so /gear, the
--                          facets and `?device=` treat it as a body with no new
--                          code; the provenance is what says it was typed, not
--                          read, and what `?device_source=named` filters on
--                          ("everything not shot by a camera I have a file
--                          for"). Like 'manual', it yields to a file that later
--                          names a body.
--   device_source 'none'   Not a camera at all — a screenshot, a webcam frame,
--                          an image saved from an app. `device` stays NULL; the
--                          provenance alone takes the medium out of the Devices
--                          backlog. Nothing is hidden or deleted: the medium
--                          stays in every grid, and `?device_source=none` is
--                          the list to clean up from.
--
-- No column: two more values of the existing provenance, which costs the CHECK
-- and nothing per row. The maintainer weighed a dedicated "ignored" boolean and
-- preferred the smallest change; this is it.
--
-- Same drop-whatever-CHECK-mentions-the-column-then-recreate idiom as 0048,
-- which named the constraint but may not be the last to have touched it.

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
    CHECK (device_source IN
      ('exif', 'derived', 'manual', 'embedded', 'override', 'named', 'none'));
END $$;
