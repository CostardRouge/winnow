// Persisted application settings (app_settings table): scan pause + hourly
// rates. Source of truth shared by the API (UI) and the workers.
//   - scanPaused      : suspends indexing AND derivative generation.
//   - scanPerHour     : max number of files *read* (hash+EXIF) per hour (0 = unlimited).
//   - analyzePerHour  : max number of derivatives generated per hour (0 = unlimited).
// A small cache (TTL) avoids hammering Postgres: the workers call
// getSettings() very often (per file / per job).
import { many, q } from "./db";

export type AppSettings = {
  scanPaused: boolean;
  scanPerHour: number;
  analyzePerHour: number;
  // RAW+JPEG pairing: when exporting a pair, also copy the JPEG companion next
  // to the RAW keeper. Default false (RAW only). Cf. lib/export.ts, lib/pairing.ts.
  exportIncludeJpeg: boolean;
  // Live Photo pairing: when exporting a Live Photo, also copy the .mov motion
  // next to the still keeper. Default false (still only). Cf. lib/export.ts.
  exportIncludeLiveVideo: boolean;
  // Reverse geocoding (GPS → place names, cf. lib/geocode.ts).
  //   - geocodePerHour   : max reverse-geocode calls/hour (0 = unlimited). The
  //     default paces the free Nominatim public instance (~1 req/s = 3600/h).
  //   - geocodePrecisionM: grid step (metres) that snaps coordinates to a shared
  //     cell — every asset in the same cell reuses one lookup. Bigger = fewer
  //     calls + coarser tags; 5 km groups a region under one place.
  geocodePerHour: number;
  geocodePrecisionM: number;
};

const DEFAULTS: AppSettings = {
  scanPaused: false,
  scanPerHour: 0,
  analyzePerHour: 0,
  exportIncludeJpeg: false,
  exportIncludeLiveVideo: false,
  geocodePerHour: 3600,
  geocodePrecisionM: 5000,
};

const TTL_MS = 1500;
let cache: { value: AppSettings; at: number } | null = null;

export async function getSettings(force = false): Promise<AppSettings> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value: AppSettings = { ...DEFAULTS };
  try {
    const rows = await many<{ key: string; value: unknown }>(
      "SELECT key, value FROM app_settings",
    );
    for (const r of rows) {
      if (r.key === "scan_paused") value.scanPaused = r.value === true;
      else if (r.key === "scan_per_hour")
        value.scanPerHour = Math.max(0, Number(r.value) || 0);
      else if (r.key === "analyze_per_hour")
        value.analyzePerHour = Math.max(0, Number(r.value) || 0);
      else if (r.key === "export_include_jpeg")
        value.exportIncludeJpeg = r.value === true;
      else if (r.key === "export_include_live_video")
        value.exportIncludeLiveVideo = r.value === true;
      else if (r.key === "geocode_per_hour")
        value.geocodePerHour = Math.max(0, Number(r.value) || 0);
      else if (r.key === "geocode_precision_m")
        value.geocodePrecisionM = Math.max(1, Number(r.value) || DEFAULTS.geocodePrecisionM);
    }
  } catch {
    // Table absent (before migration) or Postgres unavailable: we fall back
    // on the default values rather than failing the worker.
  }
  cache = { value, at: Date.now() };
  return value;
}

export async function setSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const entries: Array<[string, string]> = [];
  if (patch.scanPerHour !== undefined)
    entries.push(["scan_per_hour", JSON.stringify(Math.max(0, Math.floor(patch.scanPerHour)))]);
  if (patch.analyzePerHour !== undefined)
    entries.push(["analyze_per_hour", JSON.stringify(Math.max(0, Math.floor(patch.analyzePerHour)))]);
  if (patch.scanPaused !== undefined)
    entries.push(["scan_paused", JSON.stringify(Boolean(patch.scanPaused))]);
  if (patch.exportIncludeJpeg !== undefined)
    entries.push(["export_include_jpeg", JSON.stringify(Boolean(patch.exportIncludeJpeg))]);
  if (patch.exportIncludeLiveVideo !== undefined)
    entries.push([
      "export_include_live_video",
      JSON.stringify(Boolean(patch.exportIncludeLiveVideo)),
    ]);
  if (patch.geocodePerHour !== undefined)
    entries.push([
      "geocode_per_hour",
      JSON.stringify(Math.max(0, Math.floor(patch.geocodePerHour))),
    ]);
  if (patch.geocodePrecisionM !== undefined)
    entries.push([
      "geocode_precision_m",
      JSON.stringify(Math.max(1, Math.floor(patch.geocodePrecisionM))),
    ]);

  for (const [key, value] of entries) {
    await q(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }
  cache = null; // invalidate the cache: the next read re-reads the DB
  return getSettings(true);
}
