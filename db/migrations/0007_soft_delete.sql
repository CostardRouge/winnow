-- Soft delete: culling never touches the RAW originals (guiding principle), so
-- "delete" only hides an asset from the library. `deleted_at` is set on delete
-- (cleared on restore). Every listing/export query filters `deleted_at IS NULL`
-- (centralised in lib/filter.ts buildFilter).
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index: the hot path is "not deleted", so keep it cheap.
CREATE INDEX IF NOT EXISTS assets_not_deleted_idx
  ON assets (id) WHERE deleted_at IS NULL;
