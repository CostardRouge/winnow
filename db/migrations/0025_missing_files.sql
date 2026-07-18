-- File integrity: track indexed assets whose ORIGINAL is no longer on disk.
--
-- The indexer only ever walks files that exist, so a source file deleted from
-- the NAS (or an empty file cleaned up by hand) left its asset row behind
-- forever — still listed in the gallery and its session, with a derivative that
-- can never be (re)built. `missing_at` marks the moment a scan (or the
-- integrity sweep, cf. lib/integrity.ts) confirmed the file is gone:
--
--   - NULL      : the file was present at the last check (nominal).
--   - non-NULL  : the original is gone from disk. The detector normally also
--     soft-deletes the asset in the same statement (deleted_at = missing_at,
--     the reversible recycle bin) so it leaves every grid immediately; under
--     the mass-disappearance guard (an unmounted NAS looks like everything
--     vanished at once) the asset is only FLAGGED, never auto-trashed.
--
-- A file that reappears (NAS remounted, restored from backup) clears the flag
-- on the next scan — and lifts the auto-trash, recognized by
-- deleted_at = missing_at (both stamped by the same statement, so they carry
-- the same transaction timestamp). A user-trashed asset never matches that
-- equality and is left untouched. Triage lives in /pipeline/failures
-- ("Missing files"): re-check, or purge the leftovers for good.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS missing_at TIMESTAMPTZ;

-- Partial index: the missing set is tiny compared to the library, and every
-- read (failure counts, triage list, reappearance pass) filters on non-NULL.
CREATE INDEX IF NOT EXISTS assets_missing_idx
  ON assets (missing_at) WHERE missing_at IS NOT NULL;
