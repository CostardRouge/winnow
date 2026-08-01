// PATCH /api/assets/:id/rating { verdict?, star?, color } → culling state.
// Also moves the asset to processing_state='triaged' (unless already exported).
import { NextRequest } from "next/server";
import { z } from "zod";
import { one, q } from "@/lib/db";
import { groupExpandCTE } from "@/lib/pairing";
import { identityFromHeaders } from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";
import type { Rating } from "@/lib/types";

const Body = z.object({
  verdict: z.enum(["pick", "reject", "skip", "unrated"]).optional(),
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

    // RAW+JPEG pairing: the verdict/star applies to the whole pair, so the
    // upsert targets the asset AND its group companion (cf. lib/pairing.ts).
    // Attribution: the account acting is stamped on the rating (kept when the
    // identity is somehow absent, never erased — cf. migration 0032).
    const userId = identityFromHeaders(req.headers)?.id ?? null;
    await q(
      `WITH ${groupExpandCTE("$1")}
       INSERT INTO ratings (asset_id, verdict, star, color_label, reviewed_at, rated_by)
       SELECT id, COALESCE($2,'unrated'), COALESCE($3,0), $4, now(), $6
       FROM target_ids
       ON CONFLICT (asset_id) DO UPDATE SET
         verdict     = COALESCE($2, ratings.verdict),
         star        = COALESCE($3, ratings.star),
         color_label = CASE WHEN $5 THEN $4 ELSE ratings.color_label END,
         reviewed_at = now(),
         rated_by    = COALESCE($6, ratings.rated_by)`,
      [[assetId], verdict ?? null, star ?? null, color ?? null, color !== undefined, userId],
    );

    await q(
      `WITH ${groupExpandCTE("$1")}
       UPDATE assets SET processing_state = 'triaged', updated_at = now()
       WHERE id IN (SELECT id FROM target_ids) AND processing_state = 'unprocessed'`,
      [[assetId]],
    );

    // Return the requested asset's rating (the companion's mirrors it).
    const rating = await one<Rating>(
      `SELECT * FROM ratings WHERE asset_id = $1`,
      [assetId],
    );

    return json({ rating });
  } catch (err) {
    return serverError(err);
  }
}
