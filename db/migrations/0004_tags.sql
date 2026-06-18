-- Tags libres (activation des tables existantes tags/asset_tags).
ALTER TABLE tags ADD COLUMN IF NOT EXISTS color TEXT;
-- Lookup inverse (assets d'un tag) : la PK asset_tags(asset_id, tag_id) couvre
-- déjà le sens asset→tags ; on ajoute l'index tag→assets.
CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags (tag_id);
