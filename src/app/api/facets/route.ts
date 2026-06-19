// GET /api/facets?kind=incoming|final → valeurs disponibles (+ comptes) pour
// construire les filtres. Comptes globaux (v1), éventuellement restreints au
// rôle de dossier (Incoming/Final) ; le filtrage cumulatif s'applique ensuite
// côté résultats.
import { NextRequest } from "next/server";
import { many, one } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { json, serverError } from "@/lib/api";

// Route adossée à la DB : jamais pré-rendue/mise en cache au build (sinon Next
// exécute la requête au build et fige une réponse vide dans l'image).
export const dynamic = "force-dynamic";

type ValueCount = { value: string | number; count: number };

// `scope` est un fragment SQL commençant par " AND …" (ou "") qui restreint les
// assets au rôle demandé ; `params` porte ses paramètres positionnels. Toutes
// les requêtes aliasent `assets a` pour que la sous-requête de scope (sur
// `a.session_id`) résolve.
async function facet(
  column: string,
  scope: string,
  params: unknown[],
  order = "count DESC",
): Promise<ValueCount[]> {
  const rows = await many<{ value: string | number | null; count: number }>(
    `SELECT ${column} AS value, count(*)::int AS count
     FROM assets a
     WHERE ${column} IS NOT NULL${scope}
     GROUP BY ${column}
     ORDER BY ${order}`,
    params,
  );
  return rows
    .filter((r) => r.value !== null && r.value !== "")
    .map((r) => ({ value: r.value as string | number, count: r.count }));
}

// `allSettled` : une sous-requête en échec (p. ex. table `tags` absente, hoquet
// DB) renvoie une facette vide au lieu de faire planter tout l'endpoint — la
// galerie reste utilisable et le front ne reçoit plus un objet d'erreur à la
// place de la forme attendue.
async function settledArray(p: Promise<ValueCount[]>): Promise<ValueCount[]> {
  const r = await Promise.allSettled([p]);
  if (r[0].status === "fulfilled") return r[0].value;
  console.error("facet error:", r[0].reason);
  return [];
}

export async function GET(req: NextRequest) {
  try {
    // Seul `kind` (le rôle) nous intéresse ici : les autres dimensions sont des
    // facettes, pas un scope.
    const { kind } = filterFromSearchParams(req.nextUrl.searchParams);
    const { conditions, params } = buildFilter(kind ? { kind } : {}, 1);
    const scope = conditions.length ? ` AND ${conditions.join(" AND ")}` : "";

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
      one<{ count: number }>(
        `SELECT count(*)::int AS count FROM assets a WHERE true${scope}`,
        params,
      ).catch(() => null),
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
         FROM assets a WHERE true${scope}`,
        params,
      ).catch(() => null),
      settledArray(facet("capture_year", scope, params, "value DESC")),
      settledArray(facet("capture_month", scope, params, "value ASC")),
      settledArray(facet("capture_day", scope, params, "value ASC")),
      settledArray(facet("device", scope, params)),
      settledArray(facet("camera_model", scope, params)),
      settledArray(facet("lens", scope, params)),
      settledArray(facet("ext", scope, params)),
      settledArray(facet("media_type", scope, params, "value ASC")),
      settledArray(
        many<{ value: string; count: number }>(
          `SELECT t.name AS value, count(*)::int AS count
           FROM asset_tags at
           JOIN tags t ON t.id = at.tag_id
           JOIN assets a ON a.id = at.asset_id
           WHERE true${scope}
           GROUP BY t.name ORDER BY count DESC`,
          params,
        ),
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
