-- Finals → sources reconciliation (§8): link each edited "final" back to the
-- original capture it was derived from, so the app can pair before/after.
--
-- Tool-agnostic by design. The match keys on what every editor (Capture One,
-- Photomator, Lightroom…) preserves on export — the filename basename and the
-- original capture time — never on Capture One specifics. Both sides are already
-- indexed as `assets` (finals roots are walked, view-only — cf. lib/volumes.ts),
-- so reconciliation is a pure DB pass: retroactive over the existing library and
-- cheap to re-run (cf. lib/reconcile.ts).

-- A final's link to its source original. NULL for sources and for finals not yet
-- (or not confidently) matched. ON DELETE SET NULL: removing a source drops the
-- link, never the edited final.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS original_asset_id BIGINT
    REFERENCES assets(id) ON DELETE SET NULL;

-- How the link was established: 'name_date' (basename + capture time agreed),
-- 'name' (basename only — one side carried no capture time), 'manual' (a future
-- user override). NULL while unmatched.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS edit_match TEXT;

-- Reverse lookup "edits of this source" (the before → after fan-out).
CREATE INDEX IF NOT EXISTS assets_original_idx
  ON assets (original_asset_id) WHERE original_asset_id IS NOT NULL;

-- Speeds the basename join the matcher runs. The expression MUST match the one
-- in lib/reconcile.ts (lower(filename) with the extension stripped) for the
-- planner to use this index.
CREATE INDEX IF NOT EXISTS assets_basename_idx
  ON assets (lower(regexp_replace(filename, '\.[^.]+$', '')));
