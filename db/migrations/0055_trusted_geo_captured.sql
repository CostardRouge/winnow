-- The Unplaced view's per-frame read (lib/unplacedTrace.ts, neighbourCounts;
-- docs/UNPLACED.md §13): for every frame still to place, the TRUSTED located
-- frame just before its minute and the one just after — a camera fix, a
-- hand-placed pin or an imported track's ('inferred' guesses never count).
--
-- Without this, each of those two lookups walks captured_at's index
-- (assets_captured_cursor_idx) backwards or forwards through every asset in
-- between and checks gps_lat / gps_source row by row: a freshly imported
-- 3 000-frame folder with no phone beside it would cost each frame a walk
-- through the whole folder, millions of row checks per page load. The
-- located frames are a minority of the library's media; partial on exactly
-- the lookups' predicate, so the planner can prove it applies.
--
-- Also serves the cards' donor reads (lib/unplaced.ts steps 4, 4b and 5),
-- which select the same rows over a ±1 h range.
CREATE INDEX IF NOT EXISTS assets_trusted_geo_captured_idx
  ON assets (captured_at)
  WHERE gps_lat IS NOT NULL AND deleted_at IS NULL
    AND (gps_source IS NULL OR gps_source IN ('manual', 'track'));
