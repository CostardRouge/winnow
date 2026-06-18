// POST /api/tags/assign { ids[], add?: string[], remove?: string[] }
// Action de masse (et unitaire via ids:[id]). Crée les tags manquants par nom,
// ajoute/retire les liaisons asset_tags. N'altère pas processing_state.
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  add: z.array(z.string().trim().min(1).max(64)).optional(),
  remove: z.array(z.string().trim().min(1).max(64)).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Paramètres invalides", parsed.error.issues);
    const { ids, add, remove } = parsed.data;
    if (!add?.length && !remove?.length)
      return badRequest("add ou remove requis");

    if (add?.length) {
      // Crée les tags manquants…
      await q(
        `INSERT INTO tags (name)
         SELECT DISTINCT trim(x) FROM unnest($1::text[]) AS x
         ON CONFLICT (name) DO NOTHING`,
        [add],
      );
      // …puis les liaisons (produit ids × tags).
      await q(
        `INSERT INTO asset_tags (asset_id, tag_id)
         SELECT a.id, t.id
         FROM unnest($1::bigint[]) AS a(id)
         CROSS JOIN tags t
         WHERE t.name = ANY($2)
         ON CONFLICT DO NOTHING`,
        [ids, add],
      );
    }

    if (remove?.length) {
      await q(
        `DELETE FROM asset_tags
         WHERE asset_id = ANY($1::bigint[])
           AND tag_id IN (SELECT id FROM tags WHERE name = ANY($2))`,
        [ids, remove],
      );
    }

    return json({ updated: ids.length });
  } catch (err) {
    return serverError(err);
  }
}
