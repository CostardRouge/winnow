-- Grid feed hot-path indexes.
--
-- Every gallery/session listing filters `deleted_at IS NULL` (constant
-- predicate, cf. lib/filter.ts buildFilter) and keysets on (captured_at, id).
-- The full assets_captured_cursor_idx (0001) also serves the trash view, but
-- the live library is better served by a partial index that matches the
-- constant predicate exactly: smaller, denser, stays hot in cache.
CREATE INDEX IF NOT EXISTS assets_live_captured_idx
  ON assets (captured_at, id) WHERE deleted_at IS NULL;

-- The Pipeline triage pages sort by what was *touched* last (`sort=recent` →
-- ORDER BY updated_at, id). That path had no index at all, so every page paid
-- a full sort. Same keyset shape, same partial guard.
CREATE INDEX IF NOT EXISTS assets_live_updated_idx
  ON assets (updated_at, id) WHERE deleted_at IS NULL;
