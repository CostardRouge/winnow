-- Device attribution (cf. lib/deviceAttribution.ts, api/pipeline/device-attribution).
--
-- `assets.device` is built from the file's EXIF Make+Model (lib/extract.ts) and
-- is the grouping key of the whole gear dimension: the /gear shelf aggregates on
-- it, /api/facets lists it, `?device=` filters on it. A file that carries
-- neither atom therefore falls out of that dimension entirely — the case that
-- motivated this migration is the DJI drone, which stamps Make/Model on its
-- stills (`DJI FC8482`) and nothing at all in its MP4 container, so half the
-- aircraft's work is invisible on its own card.
--
--   device_source   Where the value in `device`/`camera_model` came from:
--                   NULL or 'exif' → read off the file, the normal case;
--                   'derived'      → attributed by a rule (the confidence vote
--                                    in lib/deviceAttribution.ts, e.g. a clip
--                                    whose DJI .SRT flight log parsed);
--                   'manual'       → a human picked the body in the UI;
--                   'embedded'     → read out of a container's timed-metadata
--                                    track (exiftool -ee), reserved for the
--                                    deep re-read that is not wired yet.
--
-- The column exists for one load-bearing reason: the indexer must NOT overwrite
-- an attributed body with the file's own null on the next re-index. Exactly the
-- contract `gps_source = 'manual'` has carried since 0031, and the same
-- CASE guard in lib/indexer.ts enforces it. Without it an attribution survives
-- only until the clip's mtime changes.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS device_source TEXT
  CHECK (device_source IN ('exif', 'derived', 'manual', 'embedded'));

-- The attribution triage list and its nav badge both ask the same question —
-- "live media carrying no body" — over a column that is NULL for a small
-- minority of rows. A partial index keeps that count off a full scan as the
-- library grows; it also serves the candidate listing, which starts from the
-- same predicate.
CREATE INDEX IF NOT EXISTS assets_device_missing_idx
  ON assets (media_type, captured_at DESC)
  WHERE device IS NULL AND deleted_at IS NULL;
