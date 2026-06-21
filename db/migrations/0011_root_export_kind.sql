-- Volumes: a directory can now be registered as an 'export' volume — listed in
-- the Volumes table for visibility, but NOT walked for indexing (export folders
-- hold RAW copies that mirror originals; culling them would be noise). The role
-- mapping (lib/roles.ts) still only scopes galleries to incoming/final, so an
-- 'export' root simply belongs to neither gallery scope.
ALTER TABLE roots DROP CONSTRAINT IF EXISTS roots_kind_check;
ALTER TABLE roots
  ADD CONSTRAINT roots_kind_check
  CHECK (kind IN ('source', 'finals', 'inbox', 'export'));
