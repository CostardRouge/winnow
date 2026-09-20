-- Two additions to the geotagging story started in 0031 (manual geotag) and
-- 0010 (materialized gps_lat/gps_lon):
--
--   geo_exempt_at   Set once, by hand, one asset at a time, when a human
--                   decides this media will never need a GPS position (a
--                   screenshot, a scanned document…). NULL = not exempted.
--                   Never folder-scoped: a folder routinely mixes real photos
--                   and screenshots, so exemption has to be a per-asset call.
--   gps_source      Gains a third value, 'inferred', alongside the existing
--                   NULL (camera/telemetry fix) and 'manual' (0031, a human
--                   placed a pin knowing the exact position). 'inferred' means
--                   a human accepted a bulk folder-level suggestion derived
--                   from a nearby located frame, without personally verifying
--                   this asset's exact position — lower confidence than
--                   'manual', which is why the EXIF write-back path (0031)
--                   must never treat it as write-worthy (enforced in
--                   application code, not here).
--
-- The gps_source CHECK added in 0031 was written inline on the ADD COLUMN
-- clause, so Postgres auto-named it (almost certainly assets_gps_source_check,
-- but that is a guess, not a guarantee across every environment/PG version
-- this has run on). Hard-coding DROP CONSTRAINT under a guessed name risks a
-- silent no-op if the guess is wrong, leaving the OLD two-value CHECK in force
-- while this migration reports success. So the block below looks up whatever
-- CHECK constraint on assets actually mentions gps_source, by inspecting
-- pg_get_constraintdef() (simpler and just as robust here as joining
-- pg_attribute/conkey), drops it under its real name, and always recreates the
-- three-value version fresh under a name we control. That drop-then-recreate
-- is naturally idempotent: rerun this after it already applied and it just
-- finds+drops the canonical name and re-adds the same definition.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS geo_exempt_at TIMESTAMPTZ;

-- Per-session "still needs a position" backlog count: assets with no GPS fix,
-- not exempted, not soft-deleted. Same partial-index idiom as
-- assets_gps_coords_idx (0010) and assets_trash_idx (0012) — index only the
-- rows the query actually wants, keyed on session_id since the backlog is
-- always scoped to one session.
CREATE INDEX IF NOT EXISTS assets_geo_todo_idx ON assets (session_id)
  WHERE gps_lat IS NULL AND geo_exempt_at IS NULL AND deleted_at IS NULL;

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
    CHECK (gps_source IN ('manual', 'inferred'));
END $$;
