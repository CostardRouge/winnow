-- Reverse-geocoded locations (§ "Places"). Turns the raw GPS coordinates we
-- already materialize (gps_lat/gps_lon, migration 0010) into human place names —
-- country / region / département / city — so the gallery can filter by "where",
-- not just by a map bounding box.
--
-- Two-part design:
--   1. `places` is a CACHE keyed by a coordinate CELL (lat/lon snapped to a grid
--      whose step is the configured precision, e.g. ~5 km). Every asset whose
--      coordinates fall in the same cell shares one row, so a RAW+JPEG pair — or
--      every photo of the same trip — costs a SINGLE reverse-geocode call. This
--      is what keeps a free/rate-limited provider (Nominatim) viable over ~90k
--      geotagged media: the 90k collapse to a few hundred/thousand unique cells.
--   2. The handful of FILTERABLE names are DENORMALIZED back onto `assets`
--      (place_country/region/county/city + place_poi), mirroring the
--      materialize-plain-columns pattern of migrations 0003/0010 so the existing
--      facet/filter machinery stays fast and JOIN-free. The full provider payload
--      lives ONCE in places.raw, never duplicated across the assets.

CREATE TABLE IF NOT EXISTS places (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Representative (snapped) coordinate of the cell + the precision that produced
  -- it. The triple is the cache key: lowering the precision later just starts a
  -- fresh grid rather than corrupting existing rows.
  cell_lat     DOUBLE PRECISION NOT NULL,
  cell_lon     DOUBLE PRECISION NOT NULL,
  precision_m  INTEGER NOT NULL,
  country      TEXT,
  country_code TEXT,
  region       TEXT,   -- state / région
  county       TEXT,   -- department / département
  city         TEXT,   -- municipality / commune / ville
  display_name TEXT,   -- provider's full formatted label
  provider     TEXT NOT NULL,
  raw          JSONB,  -- full provider response (future-proof: new fields need no re-fetch)
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per cell: the dedup key that lets nearby coordinates reuse a lookup.
CREATE UNIQUE INDEX IF NOT EXISTS places_cell_uniq
  ON places (cell_lat, cell_lon, precision_m);

-- Link + status on the asset. `place_id` ties the asset to its (shared) cell;
-- `geocode_status` mirrors derivative_status so the pipeline/UI can reason about
-- it the same way. The denormalized name columns feed facets/filters directly.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS place_id BIGINT
  REFERENCES places(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS geocode_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (geocode_status IN ('pending','processing','ready','error','skipped'));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS geocode_error TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS place_country TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS place_region  TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS place_county  TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS place_city    TEXT;
-- Tourist / point-of-interest name. Resolved at the asset's EXACT coordinate by
-- the manual "Resolve location" action (a 5 km cell is far too coarse for a
-- landmark), so it lives only here, per-asset — never in the shared cell cache.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS place_poi     TEXT;

-- Facet/filter indexes (same categorical pattern as device/lens in 0003).
CREATE INDEX IF NOT EXISTS assets_place_country_idx ON assets (place_country);
CREATE INDEX IF NOT EXISTS assets_place_region_idx  ON assets (place_region);
CREATE INDEX IF NOT EXISTS assets_place_county_idx  ON assets (place_county);
CREATE INDEX IF NOT EXISTS assets_place_city_idx    ON assets (place_city);
CREATE INDEX IF NOT EXISTS assets_place_poi_idx     ON assets (place_poi);
-- Backfill/auto enqueue scans for geotagged, not-yet-resolved assets: a partial
-- index over exactly that set keeps the sweep cheap on a 90k library.
CREATE INDEX IF NOT EXISTS assets_geocode_todo_idx
  ON assets (id) WHERE gps_lat IS NOT NULL AND place_id IS NULL;
