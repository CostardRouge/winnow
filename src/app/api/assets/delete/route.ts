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
import { groupExpandCTE } from "@/lib/pairing";
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
      // Explicit selection. RAW+JPEG pairing: delete/restore cascades to the
      // group companion so a pair is trashed as one logical media and no orphan
      // RAW lingers when its displayed JPEG is removed (cf. lib/pairing.ts).
      // A restore must never resurrect a purged asset.
      res = await q(
        `WITH ${groupExpandCTE("$1")}
         UPDATE assets SET ${setClause}
          WHERE id IN (SELECT id FROM target_ids)${restore ? " AND purged_at IS NULL" : ""}`,
        [ids],
      );
    } else {
      // Filter-driven: scope to the live library when deleting, to the trash
      // when restoring, so a "delete all rejects" / "restore all" is one call.
      //
      // Group-aware, exactly like the ids path above: match LOGICAL media
      // (collapse companions out of the selection) then cascade to each group's
      // companion. This keeps a pair trashed/restored as one — and, crucially,
      // stops a verdict filter from catching a companion by accident: a RAW
      // companion carries no rating of its own, so `verdict=unrated` would
      // otherwise sweep up the RAW of a *picked* pair. Collapsing first excludes
      // it; the cascade only re-adds companions of the media that actually
      // matched.
      const { conditions, params } = buildFilter(filter!, 1, {
        deleted: restore ? "trash" : "exclude",
        collapseGroups: true,
      });
      res = await q(
        `WITH seed AS (
           SELECT a.id FROM assets a
           LEFT JOIN ratings r ON r.asset_id = a.id
           WHERE ${conditions.join(" AND ")}
         ),
         ${groupExpandCTE("(SELECT COALESCE(array_agg(id), '{}') FROM seed)")}
         UPDATE assets SET ${setClause}
          WHERE id IN (SELECT id FROM target_ids)${restore ? " AND purged_at IS NULL" : ""}`,
        params,
      );
    }

    return json({ updated: res.rowCount ?? 0, deleted: !restore });
  } catch (err) {
    return serverError(err);
  }
}
