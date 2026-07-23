// Shared Leaflet tile source, used by the gallery MapView and the geotag
// location picker. Configurable so self-hosters can point at their own tile
// server; defaults to the public OpenStreetMap tiles — same source the asset
// metadata panel already links to. NEXT_PUBLIC_* is inlined at build time.
export const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ||
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION =
  process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
