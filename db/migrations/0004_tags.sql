-- Free-form tags (activates the existing tags/asset_tags tables).
ALTER TABLE tags ADD COLUMN IF NOT EXISTS color TEXT;
-- Reverse lookup (assets of a tag): the PK asset_tags(asset_id, tag_id) already
-- covers the asset→tags direction; we add the tag→assets index.
CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags (tag_id);
