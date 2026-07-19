-- Purge self-referential duplicate hits.
--
-- Background: when two overlapping index roots re-enqueue the same tree, both
-- jobs walk each file. Both pass the `existing` (abs_path) lookup as not-found,
-- then race the INSERT ... ON CONFLICT (content_hash). One inserts the asset;
-- the loser finds the freshly-inserted asset holding the hash — sitting at the
-- SAME abs_path it just scanned — and logged the file as a duplicate of itself.
-- Those rows are the ~33k entries whose "in library" and "on disk" paths are
-- identical.
--
-- src/lib/indexer.ts now guards against this (skips a self-collision instead of
-- recording it). Clear the backlog these produced. A row is self-referential
-- when its matched asset lives at the exact path recorded as the duplicate.
DELETE FROM duplicate_hits dh
USING assets a
WHERE dh.existing_asset_id = a.id
  AND a.abs_path = dh.abs_path;
