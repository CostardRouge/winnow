// POST /api/assets/delete { ids[], restore? } → soft delete (or restore).
// Culling never touches the RAW originals (guiding principle): "delete" only
// flips `deleted_at` so the asset is hidden from every listing/export. Reversible
// via `restore: true`. Single delete = ids:[id] (same as ratings/bulk, tags/assign).
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  restore: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { ids, restore } = parsed.data;

    const res = await q(
      `UPDATE assets
          SET deleted_at = ${restore ? "NULL" : "now()"}, updated_at = now()
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );

    return json({ updated: res.rowCount ?? 0, deleted: !restore });
  } catch (err) {
    return serverError(err);
  }
}
