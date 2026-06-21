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
};

const DEFAULTS: AppSettings = {
  scanPaused: false,
  scanPerHour: 0,
  analyzePerHour: 0,
  exportIncludeJpeg: false,
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
