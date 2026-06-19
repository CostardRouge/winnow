// Construction de filtres SQL partagée entre la galerie, la grille de session
// et les exports. Toutes les requêtes joignent `assets a` LEFT JOIN `ratings r`.
//
// Filtres CUMULATIFS (combinés en AND). Les dimensions catégorielles acceptent
// plusieurs valeurs (CSV → IN/ANY) ; les dimensions numériques/temporelles
// acceptent des bornes min/max. Tout repose sur des colonnes indexées (cf.
// migration 0003) — aucun calcul à la volée.
import { z } from "zod";
import { kindsForRole } from "./roles";

// "a,b,c" | ["a","b"] | "a"  →  ["a","b","c"]  (vide → undefined)
const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : v.split(",");
    const out = arr.map((s) => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
  });

const intList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : v.split(",");
    const out = arr
      .map((s) => Number.parseInt(String(s).trim(), 10))
      .filter((n) => Number.isFinite(n));
    return out.length ? out : undefined;
  });

export const FilterSchema = z
  .object({
    // Portée
    session_id: z.coerce.number().int().optional(),
    root_id: z.coerce.number().int().optional(),
    // Portée par rôle de dossier (Incoming/Final) — mappée en kinds Postgres.
    kind: z.enum(["incoming", "final"]).optional(),
    processing_state: z
      .enum(["ignored", "unprocessed", "triaged", "exported"])
      .optional(),

    // Tri
    verdict: z.enum(["pick", "reject", "unrated"]).optional(),
    star_min: z.coerce.number().int().min(0).max(5).optional(),

    // Type / format
    media_type: csv, // photo | video (multi)
    ext: csv, // .arw, .jpg… (multi)

    // Appareil / EXIF (multi)
    device: csv,
    camera_model: csv,
    lens: csv,

    // Calendrier (multi-valeurs) + plage de dates
    year: intList,
    month: intList, // 1-12
    day: intList, // 1-31
    date_from: z.string().optional(), // YYYY-MM-DD
    date_to: z.string().optional(),

    // Plages numériques
    iso_min: z.coerce.number().optional(),
    iso_max: z.coerce.number().optional(),
    aperture_min: z.coerce.number().optional(),
    aperture_max: z.coerce.number().optional(),
    focal_min: z.coerce.number().optional(),
    focal_max: z.coerce.number().optional(),
    size_min: z.coerce.number().optional(), // octets
    size_max: z.coerce.number().optional(),

    // Tags (libres) : inclusion ANY / exclusion ANY
    tags: csv,
    not_tags: csv,

    // Divers
    has_gps: z.coerce.boolean().optional(),
  })
  .strip();

export type AssetFilter = z.infer<typeof FilterSchema>;

export function buildFilter(
  filter: AssetFilter,
  startIdx = 1,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;

  const eq = (col: string, val: unknown) => {
    conditions.push(`${col} = $${i++}`);
    params.push(val);
  };
  const inAny = (col: string, vals: unknown[]) => {
    conditions.push(`${col} = ANY($${i++})`);
    params.push(vals);
  };
  const gte = (col: string, val: unknown) => {
    conditions.push(`${col} >= $${i++}`);
    params.push(val);
  };
  const lte = (col: string, val: unknown) => {
    conditions.push(`${col} <= $${i++}`);
    params.push(val);
  };

  if (filter.session_id != null) eq("a.session_id", filter.session_id);
  if (filter.root_id != null) {
    conditions.push(
      `a.session_id IN (SELECT id FROM sessions WHERE root_id = $${i++})`,
    );
    params.push(filter.root_id);
  }
  if (filter.kind != null) {
    // Scope par rôle via sessions→roots (sous-requête, comme root_id : pas de
    // JOIN supplémentaire à propager aux appelants).
    conditions.push(
      `a.session_id IN (
         SELECT s.id FROM sessions s JOIN roots rt ON rt.id = s.root_id
         WHERE rt.kind = ANY($${i++}))`,
    );
    params.push(kindsForRole(filter.kind));
  }
  if (filter.processing_state != null)
    eq("a.processing_state", filter.processing_state);

  if (filter.verdict != null) {
    if (filter.verdict === "unrated") {
      conditions.push(`COALESCE(r.verdict, 'unrated') = 'unrated'`);
    } else {
      eq("r.verdict", filter.verdict);
    }
  }
  if (filter.star_min != null) {
    conditions.push(`COALESCE(r.star, 0) >= $${i++}`);
    params.push(filter.star_min);
  }

  if (filter.media_type) inAny("a.media_type", filter.media_type);
  if (filter.ext) inAny("a.ext", filter.ext);
  if (filter.device) inAny("a.device", filter.device);
  if (filter.camera_model) inAny("a.camera_model", filter.camera_model);
  if (filter.lens) inAny("a.lens", filter.lens);

  if (filter.year) inAny("a.capture_year", filter.year);
  if (filter.month) inAny("a.capture_month", filter.month);
  if (filter.day) inAny("a.capture_day", filter.day);
  if (filter.date_from) gte("a.capture_date", filter.date_from);
  if (filter.date_to) lte("a.capture_date", filter.date_to);

  if (filter.iso_min != null) gte("a.iso", filter.iso_min);
  if (filter.iso_max != null) lte("a.iso", filter.iso_max);
  if (filter.aperture_min != null) gte("a.aperture", filter.aperture_min);
  if (filter.aperture_max != null) lte("a.aperture", filter.aperture_max);
  if (filter.focal_min != null) gte("a.focal_length", filter.focal_min);
  if (filter.focal_max != null) lte("a.focal_length", filter.focal_max);
  if (filter.size_min != null) gte("a.file_size", filter.size_min);
  if (filter.size_max != null) lte("a.file_size", filter.size_max);

  if (filter.tags) {
    conditions.push(
      `EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
               WHERE at.asset_id = a.id AND t.name = ANY($${i++}))`,
    );
    params.push(filter.tags);
  }
  if (filter.not_tags) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                   WHERE at.asset_id = a.id AND t.name = ANY($${i++}))`,
    );
    params.push(filter.not_tags);
  }

  if (filter.has_gps) conditions.push(`a.gps IS NOT NULL`);

  return { conditions, params };
}

// Parse les filtres depuis les query params d'une URL (toutes dimensions).
export function filterFromSearchParams(sp: URLSearchParams): AssetFilter {
  const keys = [
    "session_id",
    "root_id",
    "kind",
    "processing_state",
    "tags",
    "not_tags",
    "verdict",
    "star_min",
    "media_type",
    "ext",
    "device",
    "camera_model",
    "lens",
    "year",
    "month",
    "day",
    "date_from",
    "date_to",
    "iso_min",
    "iso_max",
    "aperture_min",
    "aperture_max",
    "focal_min",
    "focal_max",
    "size_min",
    "size_max",
    "has_gps",
  ] as const;
  const raw: Record<string, string> = {};
  for (const k of keys) {
    const v = sp.get(k);
    if (v != null && v !== "") raw[k] = v;
  }
  return FilterSchema.parse(raw);
}
