-- Attributs filtrables matérialisés + indexés (galerie à filtres cumulatifs).
-- Les composantes calendaires d'un timestamptz ne sont pas IMMUTABLE (donc ni
-- colonne générée ni index fonctionnel direct) : on matérialise via un trigger
-- et on indexe des colonnes simples.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS capture_date  DATE;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS capture_year  INTEGER;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS capture_month SMALLINT; -- 1-12
ALTER TABLE assets ADD COLUMN IF NOT EXISTS capture_day   SMALLINT; -- 1-31

CREATE OR REPLACE FUNCTION winnow_set_capture_parts() RETURNS trigger AS $$
BEGIN
  IF NEW.captured_at IS NULL THEN
    NEW.capture_date  := NULL;
    NEW.capture_year  := NULL;
    NEW.capture_month := NULL;
    NEW.capture_day   := NULL;
  ELSE
    NEW.capture_date  := (NEW.captured_at AT TIME ZONE 'UTC')::date;
    NEW.capture_year  := EXTRACT(YEAR  FROM (NEW.captured_at AT TIME ZONE 'UTC'))::int;
    NEW.capture_month := EXTRACT(MONTH FROM (NEW.captured_at AT TIME ZONE 'UTC'))::int;
    NEW.capture_day   := EXTRACT(DAY   FROM (NEW.captured_at AT TIME ZONE 'UTC'))::int;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assets_capture_parts ON assets;
CREATE TRIGGER assets_capture_parts
  BEFORE INSERT OR UPDATE OF captured_at ON assets
  FOR EACH ROW EXECUTE FUNCTION winnow_set_capture_parts();

-- Backfill des lignes existantes (UTC, cohérent avec le foldering d'import).
UPDATE assets SET
  capture_date  = (captured_at AT TIME ZONE 'UTC')::date,
  capture_year  = EXTRACT(YEAR  FROM (captured_at AT TIME ZONE 'UTC'))::int,
  capture_month = EXTRACT(MONTH FROM (captured_at AT TIME ZONE 'UTC'))::int,
  capture_day   = EXTRACT(DAY   FROM (captured_at AT TIME ZONE 'UTC'))::int
WHERE captured_at IS NOT NULL;

-- Index des dimensions de filtrage (catégorielles + plages).
CREATE INDEX IF NOT EXISTS assets_capture_date_idx  ON assets (capture_date);
CREATE INDEX IF NOT EXISTS assets_capture_year_idx   ON assets (capture_year);
CREATE INDEX IF NOT EXISTS assets_capture_month_idx  ON assets (capture_month);
CREATE INDEX IF NOT EXISTS assets_capture_day_idx    ON assets (capture_day);
CREATE INDEX IF NOT EXISTS assets_device_idx         ON assets (device);
CREATE INDEX IF NOT EXISTS assets_ext_idx            ON assets (ext);
CREATE INDEX IF NOT EXISTS assets_media_type_idx     ON assets (media_type);
CREATE INDEX IF NOT EXISTS assets_file_size_idx      ON assets (file_size);
CREATE INDEX IF NOT EXISTS assets_camera_model_idx   ON assets (camera_model);
CREATE INDEX IF NOT EXISTS assets_lens_idx           ON assets (lens);
CREATE INDEX IF NOT EXISTS assets_iso_idx            ON assets (iso);
CREATE INDEX IF NOT EXISTS assets_focal_idx          ON assets (focal_length);
CREATE INDEX IF NOT EXISTS assets_aperture_idx       ON assets (aperture);
