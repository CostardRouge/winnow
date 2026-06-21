// POST /api/assets/delete { ids[] | filter, restore? } → soft delete (or restore).
// Culling never touches the RAW originals (guiding principle): "delete" only
// flips `deleted_at` so the asset is hidden from every listing/export — the
// recycle bin. Reversible via `restore: true`. Reclaiming the space is a
// separate, confirmed step (POST /api/purge).
//
// Targets either an explicit `ids` list (single = ids:[id], same as
// ratings/bulk) OR a `filter` — e.g. `{ verdict: "reject" }` to send every
// rejected shot to the trash in one go. Restores never resurrect a purged asset
// (its file is gone): they only touch the trash (deleted, not purged).
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { buildFilter, FilterSchema } from "@/lib/filter";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z
  .object({
    ids: z.array(z.number().int()).optional(),
    filter: FilterSchema.optional(),
    restore: z.boolean().optional(),
  })
  .refine((b) => (b.ids && b.ids.length > 0) || b.filter != null, {
    message: "Provide ids[] or a filter",
  });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { ids, filter, restore } = parsed.data;

    const setClause = `deleted_at = ${restore ? "NULL" : "now()"}, updated_at = now()`;

    let res;
    if (ids && ids.length) {
      // Explicit selection. A restore must never resurrect a purged asset.
      res = await q(
        `UPDATE assets SET ${setClause}
          WHERE id = ANY($1::bigint[])${restore ? " AND purged_at IS NULL" : ""}`,
        [ids],
      );
    } else {
      // Filter-driven: scope to the live library when deleting, to the trash
      // when restoring, so a "delete all rejects" / "restore all" is one call.
      const { conditions, params } = buildFilter(filter!, 1, {
        deleted: restore ? "trash" : "exclude",
      });
      res = await q(
        `UPDATE assets SET ${setClause}
          WHERE id IN (
            SELECT a.id FROM assets a
            LEFT JOIN ratings r ON r.asset_id = a.id
            WHERE ${conditions.join(" AND ")}
          )`,
        params,
      );
    }

    return json({ updated: res.rowCount ?? 0, deleted: !restore });
  } catch (err) {
    return serverError(err);
  }
}
