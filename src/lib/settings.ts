// Réglages applicatifs persistés (table app_settings) : pause du scan + débits
// horaires. Source de vérité partagée par l'API (UI) et les workers.
//   - scanPaused      : suspend l'indexation ET la génération de dérivés.
//   - scanPerHour     : nb max de fichiers *lus* (hash+EXIF) par heure (0 = illimité).
//   - analyzePerHour  : nb max de dérivés générés par heure (0 = illimité).
// Un petit cache (TTL) évite de marteler Postgres : les workers appellent
// getSettings() très souvent (par fichier / par job).
import { many, q } from "./db";

export type AppSettings = {
  scanPaused: boolean;
  scanPerHour: number;
  analyzePerHour: number;
};

const DEFAULTS: AppSettings = {
  scanPaused: false,
  scanPerHour: 0,
  analyzePerHour: 0,
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
    }
  } catch {
    // Table absente (avant migration) ou Postgres indisponible : on retombe
    // sur les valeurs par défaut plutôt que de faire échouer le worker.
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

  for (const [key, value] of entries) {
    await q(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }
  cache = null; // invalide le cache : la prochaine lecture relit la DB
  return getSettings(true);
}
