// GET /api/facets → valeurs disponibles (+ comptes) pour construire les filtres.
// Comptes globaux (v1) ; le filtrage cumulatif s'applique côté résultats.
import { many, one } from "@/lib/db";
import { json, serverError } from "@/lib/api";

type ValueCount = { value: string | number; count: number };

async function facet(
  column: string,
  order = "count DESC",
): Promise<ValueCount[]> {
  const rows = await many<{ value: string | number | null; count: number }>(
    `SELECT ${column} AS value, count(*)::int AS count
     FROM assets
     WHERE ${column} IS NOT NULL
     GROUP BY ${column}
     ORDER BY ${order}`,
  );
  return rows
    .filter((r) => r.value !== null && r.value !== "")
    .map((r) => ({ value: r.value as string | number, count: r.count }));
}

export async function GET() {
  try {
    const [
      total,
      ranges,
      years,
      months,
      days,
      devices,
      cameras,
      lenses,
      exts,
      mediaTypes,
      tags,
    ] = await Promise.all([
      one<{ count: number }>("SELECT count(*)::int AS count FROM assets"),
      one<{
        size_min: number | null;
        size_max: number | null;
        iso_min: number | null;
        iso_max: number | null;
        focal_min: number | null;
        focal_max: number | null;
        aperture_min: number | null;
        aperture_max: number | null;
      }>(
        `SELECT min(file_size) size_min, max(file_size) size_max,
                min(iso) iso_min, max(iso) iso_max,
                min(focal_length) focal_min, max(focal_length) focal_max,
                min(aperture) aperture_min, max(aperture) aperture_max
         FROM assets`,
      ),
      facet("capture_year", "value DESC"),
      facet("capture_month", "value ASC"),
      facet("capture_day", "value ASC"),
      facet("device"),
      facet("camera_model"),
      facet("lens"),
      facet("ext"),
      facet("media_type", "value ASC"),
      many<{ value: string; count: number }>(
        `SELECT t.name AS value, count(*)::int AS count
         FROM asset_tags at JOIN tags t ON t.id = at.tag_id
         GROUP BY t.name ORDER BY count DESC`,
      ),
    ]);

    return json({
      total: total?.count ?? 0,
      ranges: ranges ?? {},
      years,
      months,
      days,
      devices,
      camera_models: cameras,
      lenses,
      extensions: exts,
      media_types: mediaTypes,
      tags,
    });
  } catch (err) {
    return serverError(err);
  }
}
