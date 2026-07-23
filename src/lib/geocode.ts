// Reverse geocoding — turns GPS coordinates into place names (country, région,
// département, city) and, on demand, a tourist/POI name. Runs off its own BullMQ
// queue (cf. lib/queue.ts, worker.ts); this module owns the provider call, the
// coordinate→cell dedup, and the per-asset job that writes the result.
//
// Why a cell cache: a personal library of ~90k geotagged media collapses to a
// few hundred/thousand distinct ~5 km cells (a RAW+JPEG pair shares coordinates
// exactly; a whole trip shares a cell). We reverse-geocode each cell ONCE and
// reuse it, which is the only thing that keeps a free, rate-limited provider
// (Nominatim's public instance caps at ~1 req/s and forbids bulk) usable here.
import { config } from "./config";
import { getSettings } from "./settings";
import { one, q } from "./db";
import { reserveSlot, sleep } from "./rate";

// The four administrative names (shared across a cell) plus the POI (per-asset,
// resolved at full precision). `raw` is the untouched provider payload, cached
// once per cell in places.raw so a later field addition needs no re-fetch.
export type PlaceFields = {
  country: string | null;
  country_code: string | null;
  region: string | null;
  county: string | null;
  city: string | null;
  poi: string | null;
  display_name: string | null;
  raw: unknown;
};

type PlaceRow = {
  id: number;
  country: string | null;
  country_code: string | null;
  region: string | null;
  county: string | null;
  city: string | null;
  display_name: string | null;
};

// Trim to a clean string or null (empty/whitespace → null).
function str(v: unknown): string | null {
  if (typeof v !== "string") return v == null ? null : String(v).trim() || null;
  return v.trim() || null;
}

// Snap a coordinate to the centre of a grid cell whose latitude step is
// `precisionM` metres. Longitude uses the SAME degree step: at higher latitudes
// that makes east-west cells narrower than `precisionM` (they never merge points
// that are far apart — worst case we split a cell and do one extra lookup), which
// keeps the key trivially deterministic without a per-latitude cos() factor.
// ~111.32 km per degree of latitude.
export function snapToCell(
  lat: number,
  lon: number,
  precisionM: number,
): { cellLat: number; cellLon: number } {
  const step = Math.max(precisionM, 1) / 111_320;
  // Round to 6 decimals (~0.1 m) so the stored key is stable across float noise.
  const snap = (v: number) => Math.round((Math.round(v / step) * step) * 1e6) / 1e6;
  return { cellLat: snap(lat), cellLon: snap(lon) };
}

// --- Provider: Nominatim (OpenStreetMap) ----------------------------------
// Base URL is configurable so the exact same code path serves the public
// instance, a self-hosted Nominatim, or a Nominatim-compatible service
// (LocationIQ, Photon…) — swap GEOCODE_BASE_URL, no code change.

// Map a Nominatim `jsonv2` reverse response to our fields. Nominatim returns the
// whole admin hierarchy in `address` regardless of zoom; the POI is the matched
// feature's own name (only meaningful at a high zoom / exact coordinate).
function mapNominatim(data: {
  error?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
}): PlaceFields {
  const a = data.address ?? {};
  // City-equivalent: pick the finest populated-place tag Nominatim provides.
  const city =
    str(a.city) ??
    str(a.town) ??
    str(a.village) ??
    str(a.municipality) ??
    str(a.hamlet) ??
    str(a.suburb) ??
    null;
  const poi =
    str(data.name) ??
    str(a.tourism) ??
    str(a.attraction) ??
    str(a.leisure) ??
    str(a.historic) ??
    str(a.building) ??
    null;
  return {
    country: str(a.country),
    country_code: a.country_code ? a.country_code.toUpperCase() : null,
    region: str(a.state) ?? str(a.region),
    county: str(a.county) ?? str(a.state_district),
    city,
    poi,
    display_name: str(data.display_name),
    raw: data,
  };
}

// One reverse-geocode HTTP call. `precise` selects the zoom: coarse (admin only)
// for the shared cell, or building-level (POI resolvable) for the manual action.
async function reverseGeocode(
  lat: number,
  lon: number,
  precise: boolean,
): Promise<PlaceFields> {
  if (config.geocode.provider !== "nominatim") {
    throw new Error(`Unsupported geocode provider: ${config.geocode.provider}`);
  }
  const base = config.geocode.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/reverse`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  // zoom 18 ≈ building (POI), 12 ≈ town — enough for the admin hierarchy.
  url.searchParams.set("zoom", precise ? "18" : "12");
  if (config.geocode.language)
    url.searchParams.set("accept-language", config.geocode.language);
  if (config.geocode.email) url.searchParams.set("email", config.geocode.email);

  const res = await fetch(url, {
    headers: {
      // Nominatim's usage policy REQUIRES an identifying User-Agent.
      "User-Agent": config.geocode.userAgent,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(config.geocode.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`geocode HTTP ${res.status} from ${base}`);
  }
  const data = (await res.json()) as Parameters<typeof mapNominatim>[0];
  // Nominatim answers `{ error: "Unable to geocode" }` for e.g. open sea. That's
  // a legitimate "no place here" — cache it (all-null names) so we never re-query
  // the same empty cell.
  return mapNominatim(data);
}

// --- Forward geocoding: place-name search (the geotag autocomplete) ---------

// The provider's request budget is exhausted right now (a big reverse-geocode
// backfill is drinking it): the search API maps this to HTTP 429 so the
// autocomplete can tell "no such place" from "retry in a moment".
export class GeocodeRateLimited extends Error {
  constructor() {
    super("geocode rate limit reached — retry shortly");
  }
}

// One suggestion for the geotag place autocomplete: the provider's full display
// name plus the coordinate the map picker jumps to when it's chosen.
export type PlaceSuggestion = {
  display_name: string;
  lat: number;
  lon: number;
};

// Search places by free-typed name against the same Nominatim-compatible
// provider (and the same base URL / User-Agent / language settings) as the
// reverse geocoding above — `/search` instead of `/reverse`, no code fork per
// provider. Called by GET /api/places/search on each (debounced) keystroke of
// the geotag autocomplete; shares the reverse-geocoder's hourly budget so both
// paths together stay inside the provider's rate limit.
export async function searchPlaces(
  query: string,
  limit = 8,
): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (config.geocode.provider !== "nominatim") {
    throw new Error(`Unsupported geocode provider: ${config.geocode.provider}`);
  }
  const base = config.geocode.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(limit));
  if (config.geocode.language)
    url.searchParams.set("accept-language", config.geocode.language);
  if (config.geocode.email) url.searchParams.set("email", config.geocode.email);

  // Same hourly budget as the reverse geocoder, but with a short patience cap:
  // an interactive autocomplete keystroke must fail fast (the client just shows
  // "try again"), never hang minutes for a backfill to free the budget.
  const { geocodePerHour } = await getSettings();
  if (geocodePerHour > 0) {
    const wait = await reserveSlot("geocode", geocodePerHour);
    if (wait > 3000) throw new GeocodeRateLimited();
    if (wait > 0) await sleep(wait);
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent": config.geocode.userAgent,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(config.geocode.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`geocode HTTP ${res.status} from ${base}`);
  }
  const data = (await res.json()) as Array<{
    display_name?: string;
    lat?: string;
    lon?: string;
  }>;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const lat = Number.parseFloat(row.lat ?? "");
    const lon = Number.parseFloat(row.lon ?? "");
    const display_name = str(row.display_name);
    if (!display_name || !Number.isFinite(lat) || !Number.isFinite(lon))
      return [];
    return [{ display_name, lat, lon }];
  });
}

// Drip-feed throttle around the ONLY expensive part — the network call. A cache
// hit makes no call and never waits. The queue runs at concurrency 1, so waiting
// here simply paces the single worker (Nominatim public = ~1 req/s → set
// geocodePerHour=3600). 0 = unlimited (self-hosted / higher-tier provider).
async function throttleGeocode(): Promise<void> {
  const { geocodePerHour } = await getSettings();
  if (geocodePerHour <= 0) return;
  let wait = await reserveSlot("geocode", geocodePerHour);
  while (wait > 0) {
    await sleep(Math.min(wait, 3000));
    wait = await reserveSlot("geocode", geocodePerHour);
  }
}

// Resolve (or refresh) one asset's location.
//   - cell mode (default, used by the backfill + auto-enqueue on import): snap to
//     the cell, reuse the cached place if present (zero network), else fetch the
//     admin names once and cache them. The per-asset POI is left untouched.
//   - precise mode (`precise: true`, the manual "Resolve location" action): always
//     fetch at the asset's EXACT coordinate and additionally fill place_poi — the
//     landmark you actually stood at, which a 5 km cell can't give you.
export async function runGeocodeJob(
  assetId: number,
  opts: { precise?: boolean } = {},
): Promise<void> {
  const asset = await one<{
    id: number;
    gps_lat: number | null;
    gps_lon: number | null;
    deleted_at: string | null;
    place_poi: string | null;
  }>(
    "SELECT id, gps_lat, gps_lon, deleted_at, place_poi FROM assets WHERE id = $1",
    [assetId],
  );
  if (!asset || asset.deleted_at) return;

  // No coordinates → nothing to resolve. Terminal, not an error.
  if (asset.gps_lat == null || asset.gps_lon == null) {
    await q(
      "UPDATE assets SET geocode_status='skipped', geocode_error=NULL, updated_at=now() WHERE id=$1",
      [assetId],
    );
    return;
  }
  // Geocoding disabled: leave the asset 'pending' (don't error-storm the queue)
  // so it resolves once the feature is turned back on and re-enqueued.
  if (!config.geocode.enabled) return;

  await q(
    "UPDATE assets SET geocode_status='processing', updated_at=now() WHERE id=$1",
    [assetId],
  );

  try {
    const { geocodePrecisionM } = await getSettings();
    const precise = !!opts.precise;
    const { cellLat, cellLon } = snapToCell(
      asset.gps_lat,
      asset.gps_lon,
      geocodePrecisionM,
    );

    let place = await one<PlaceRow>(
      "SELECT id, country, country_code, region, county, city, display_name FROM places WHERE cell_lat=$1 AND cell_lon=$2 AND precision_m=$3",
      [cellLat, cellLon, geocodePrecisionM],
    );

    // Preserve any POI already resolved on this asset unless we're refreshing it
    // at full precision now.
    let poi = asset.place_poi;

    // Fetch when the cell isn't cached yet, or always in precise mode (we need
    // the exact-coordinate POI even if the admin names are already cached).
    if (!place || precise) {
      await throttleGeocode();
      const fields = await reverseGeocode(
        precise ? asset.gps_lat : cellLat,
        precise ? asset.gps_lon : cellLon,
        precise,
      );
      // Upsert the shared cell row. ON CONFLICT covers the race where a sibling
      // job inserted the same cell between our SELECT and here; precise mode also
      // refreshes the admin names (identical within a cell, so harmless).
      place = await one<PlaceRow>(
        `INSERT INTO places
           (cell_lat, cell_lon, precision_m, country, country_code, region, county, city, display_name, provider, raw, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now())
         ON CONFLICT (cell_lat, cell_lon, precision_m) DO UPDATE SET
           country=EXCLUDED.country, country_code=EXCLUDED.country_code,
           region=EXCLUDED.region, county=EXCLUDED.county, city=EXCLUDED.city,
           display_name=EXCLUDED.display_name, provider=EXCLUDED.provider,
           raw=EXCLUDED.raw, fetched_at=now()
         RETURNING id, country, country_code, region, county, city, display_name`,
        [
          cellLat,
          cellLon,
          geocodePrecisionM,
          fields.country,
          fields.country_code,
          fields.region,
          fields.county,
          fields.city,
          fields.display_name,
          config.geocode.provider,
          JSON.stringify(fields.raw ?? null),
        ],
      );
      if (precise) poi = fields.poi;
    }

    await q(
      `UPDATE assets SET
         place_id=$2, place_country=$3, place_region=$4, place_county=$5,
         place_city=$6, place_poi=$7,
         geocode_status='ready', geocode_error=NULL, updated_at=now()
       WHERE id=$1`,
      [
        assetId,
        place!.id,
        place!.country,
        place!.region,
        place!.county,
        place!.city,
        poi,
      ],
    );
  } catch (err) {
    await q(
      "UPDATE assets SET geocode_status='error', geocode_error=$2, updated_at=now() WHERE id=$1",
      [assetId, (err as Error).message?.slice(0, 500) ?? "unknown error"],
    );
    throw err;
  }
}
