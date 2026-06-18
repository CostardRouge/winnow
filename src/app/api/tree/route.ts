// GET /api/tree?group=date|folder|device&<sélection>&<filtres> → enfants + comptes.
// L'arbre ne fait que piloter les filtres galerie : chaque nœud porte sa clé/valeur
// que le client applique à l'objet Filters pour rescoper la grille.
//
// Niveau suivant déduit de la sélection présente :
//   date   : year ▸ month ▸ day
//   device : device ▸ year ▸ month ▸ day
//   folder : root ▸ session
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { json, serverError } from "@/lib/api";

type Node = {
  key: string;
  value: string | number;
  label: string;
  count: number;
  leaf: boolean;
};

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const group = sp.get("group") ?? "date";
    const filter = filterFromSearchParams(sp);
    const { conditions, params } = buildFilter(filter, 1);
    const has = (a?: unknown[]) => Array.isArray(a) && a.length > 0;

    const where = (extra: string[] = []) => {
      const all = [...conditions, ...extra];
      return all.length ? `WHERE ${all.join(" AND ")}` : "";
    };

    // Regroupement simple sur une colonne de `assets a`.
    const groupCol = async (
      col: string,
      key: string,
      order: string,
      leaf: boolean,
    ): Promise<Node[]> => {
      const rows = await many<{ value: string | number; count: number }>(
        `SELECT ${col} AS value, count(*)::int AS count
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         ${where([`${col} IS NOT NULL`])}
         GROUP BY ${col}
         ORDER BY ${order}`,
        params,
      );
      return rows.map((r) => ({
        key,
        value: r.value,
        label: String(r.value),
        count: r.count,
        leaf,
      }));
    };

    let nodes: Node[] = [];

    if (group === "folder") {
      if (filter.root_id == null) {
        const rows = await many<{ value: number; label: string; count: number }>(
          `SELECT rt.id AS value, rt.path AS label, count(*)::int AS count
           FROM assets a
           LEFT JOIN ratings r ON r.asset_id = a.id
           JOIN sessions s ON s.id = a.session_id
           JOIN roots rt ON rt.id = s.root_id
           ${where()}
           GROUP BY rt.id, rt.path
           ORDER BY rt.path`,
          params,
        );
        nodes = rows.map((r) => ({
          key: "root_id",
          value: r.value,
          label: r.label,
          count: r.count,
          leaf: false,
        }));
      } else {
        const rows = await many<{ value: number; label: string; count: number }>(
          `SELECT s.id AS value, s.name AS label, count(*)::int AS count
           FROM assets a
           LEFT JOIN ratings r ON r.asset_id = a.id
           JOIN sessions s ON s.id = a.session_id
           ${where()}
           GROUP BY s.id, s.name
           ORDER BY s.name`,
          params,
        );
        nodes = rows.map((r) => ({
          key: "session_id",
          value: r.value,
          label: r.label,
          count: r.count,
          leaf: true,
        }));
      }
    } else if (group === "device") {
      if (!has(filter.device)) nodes = await groupCol("a.device", "device", "count DESC", false);
      else if (!has(filter.year)) nodes = await groupCol("a.capture_year", "year", "value DESC", false);
      else if (!has(filter.month)) nodes = await groupCol("a.capture_month", "month", "value ASC", false);
      else if (!has(filter.day)) nodes = await groupCol("a.capture_day", "day", "value ASC", true);
    } else {
      // group === "date"
      if (!has(filter.year)) nodes = await groupCol("a.capture_year", "year", "value DESC", false);
      else if (!has(filter.month)) nodes = await groupCol("a.capture_month", "month", "value ASC", false);
      else if (!has(filter.day)) nodes = await groupCol("a.capture_day", "day", "value ASC", true);
    }

    return json({ group, nodes });
  } catch (err) {
    return serverError(err);
  }
}
