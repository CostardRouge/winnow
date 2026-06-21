-- Free-text search over the file path (folder + filename) for the gallery's
-- `q=` parameter. `rel_path` already contains the in-root folders *and* the
-- filename (path.relative(root, abs)), so a single column covers both "search by
-- filename" and "search by folder". Substring matching (ILIKE '%…%') can't use a
-- plain B-tree, so enable pg_trgm and back it with trigram GIN indexes — the
-- search then stays fast on a large library instead of scanning every row.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- rel_path subsumes the filename, but filename is indexed too so a pure
-- filename token resolves on the smaller index.
CREATE INDEX IF NOT EXISTS assets_rel_path_trgm_idx
  ON assets USING gin (rel_path gin_trgm_ops);
CREATE INDEX IF NOT EXISTS assets_filename_trgm_idx
  ON assets USING gin (filename gin_trgm_ops);
