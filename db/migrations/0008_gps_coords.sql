-- Materialize the GPS latitude/longitude out of the `gps` JSONB into plain,
-- indexed columns so the map view can filter assets by bounding box on indexed
-- SQL (no on-the-fly JSON casts). Same materialize-via-trigger pattern as the
-- calendar parts in migration 0003.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS gps_lat DOUBLE PRECISION;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS gps_lon DOUBLE PRECISION;

CREATE OR REPLACE FUNCTION winnow_set_gps_coords() RETURNS trigger AS $$
BEGIN
  IF NEW.gps IS NULL THEN
    NEW.gps_lat := NULL;
    NEW.gps_lon := NULL;
  ELSE
    NEW.gps_lat := (NEW.gps->>'lat')::double precision;
    NEW.gps_lon := (NEW.gps->>'lon')::double precision;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assets_gps_coords ON assets;
CREATE TRIGGER assets_gps_coords
  BEFORE INSERT OR UPDATE OF gps ON assets
  FOR EACH ROW EXECUTE FUNCTION winnow_set_gps_coords();

-- Backfill existing rows.
UPDATE assets SET
  gps_lat = (gps->>'lat')::double precision,
  gps_lon = (gps->>'lon')::double precision
WHERE gps IS NOT NULL;

-- Bounding-box queries scan a latitude range then a longitude range; a partial
-- composite index over the geotagged rows keeps the map fast.
CREATE INDEX IF NOT EXISTS assets_gps_coords_idx
  ON assets (gps_lat, gps_lon) WHERE gps_lat IS NOT NULL;
