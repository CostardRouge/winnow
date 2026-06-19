// PATCH /api/assets/:id/rating { verdict?, star?, color } → culling state.
// Also moves the asset to processing_state='triaged' (unless already exported).
import { NextRequest } from "next/server";
import { z } from "zod";
import { one, q } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";
import type { Rating } from "@/lib/types";

const Body = z.object({
  verdict: z.enum(["pick", "reject", "unrated"]).optional(),
  star: z.number().int().min(0).max(5).optional(),
  color: z.string().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const assetId = Number.parseInt(id, 10);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { verdict, star, color } = parsed.data;

    const rating = await one<Rating>(
      `INSERT INTO ratings (asset_id, verdict, star, color_label, reviewed_at)
       VALUES ($1, COALESCE($2,'unrated'), COALESCE($3,0), $4, now())
       ON CONFLICT (asset_id) DO UPDATE SET
         verdict     = COALESCE($2, ratings.verdict),
         star        = COALESCE($3, ratings.star),
         color_label = CASE WHEN $5 THEN $4 ELSE ratings.color_label END,
         reviewed_at = now()
       RETURNING *`,
      [assetId, verdict ?? null, star ?? null, color ?? null, color !== undefined],
    );

    await q(
      `UPDATE assets SET processing_state = 'triaged', updated_at = now()
       WHERE id = $1 AND processing_state IN ('unprocessed')`,
      [assetId],
    );

    return json({ rating });
  } catch (err) {
    return serverError(err);
  }
}
