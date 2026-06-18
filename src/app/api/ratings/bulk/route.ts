// POST /api/ratings/bulk { ids[], verdict?, star? } → tri rapide en lot.
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  verdict: z.enum(["pick", "reject", "unrated"]).optional(),
  star: z.number().int().min(0).max(5).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Paramètres invalides", parsed.error.issues);
    const { ids, verdict, star } = parsed.data;
    if (verdict == null && star == null)
      return badRequest("verdict ou star requis");

    await q(
      `INSERT INTO ratings (asset_id, verdict, star, reviewed_at)
       SELECT x.id, COALESCE($2,'unrated'), COALESCE($3,0), now()
       FROM unnest($1::bigint[]) AS x(id)
       ON CONFLICT (asset_id) DO UPDATE SET
         verdict     = COALESCE($2, ratings.verdict),
         star        = COALESCE($3, ratings.star),
         reviewed_at = now()`,
      [ids, verdict ?? null, star ?? null],
    );

    await q(
      `UPDATE assets SET processing_state = 'triaged', updated_at = now()
       WHERE id = ANY($1::bigint[]) AND processing_state = 'unprocessed'`,
      [ids],
    );

    return json({ updated: ids.length });
  } catch (err) {
    return serverError(err);
  }
}
