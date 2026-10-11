-- The fixes of an applied GPS track, kept (lib/trackImport.ts, lib/unplaced.ts),
-- and an index for the positions a human applied (end of file).
--
-- Until now an import kept only its record (track_imports: name, span, point
-- count, report) and the frames it placed at apply time. The fixes themselves
-- were read from the uploaded file and dropped. That was enough for the one
-- apply, and not for anything after it: a frame indexed later in the span, a
-- frame the apply could not reach (pre-0046 dates, re-read since), or a frame
-- the maintainer wants to "follow" from the Unplaced view had nothing left to
-- be matched against without re-uploading the file. So the apply now stores
-- every fix here, and the Unplaced view's "Follow a track…" reads them back
-- (docs/UNPLACED.md §11).
--
--   import_id   The applied import. ON DELETE CASCADE: Undo deletes the import
--               row, and its fixes go with it — nothing here outlives the
--               gesture that created it, so there is no janitor to write.
--   t           The fix's instant.
--   lat, lon    The fix.
--
-- Imports applied before this migration have no rows here: their fixes were
-- never stored. Re-importing the same file stores them (the Settings page
-- says so beside such an import).
--
-- Size: a Polarsteps trip is a few thousand fixes, a GPX of a long hike tens
-- of thousands; tens of imports in all. The (t) index serves the only read —
-- the fixes inside a card's window, ± an hour.

CREATE TABLE IF NOT EXISTS track_points (
  import_id BIGINT NOT NULL REFERENCES track_imports(id) ON DELETE CASCADE,
  t         TIMESTAMPTZ NOT NULL,
  lat       DOUBLE PRECISION NOT NULL,
  lon       DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS track_points_t_idx ON track_points (t);
CREATE INDEX IF NOT EXISTS track_points_import_idx ON track_points (import_id);

-- The Unplaced view's other new read (lib/unplaced.ts step 6, placesNear):
-- the positions a HUMAN applied ('manual', or 'inferred' — a suggestion
-- accepted), nearest in time to a card. Few rows among the library's; without
-- this, each lookup walks every asset of ±30 days on captured_at and checks
-- gps_source row by row. Partial on exactly the lookups' predicate.
CREATE INDEX IF NOT EXISTS assets_human_geo_captured_idx
  ON assets (captured_at)
  WHERE gps_source IN ('manual', 'inferred') AND gps_lat IS NOT NULL AND deleted_at IS NULL;
