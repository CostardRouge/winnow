// POST /api/ratings/bulk { ids[], verdict?, star?, expand_bursts? } → quick bulk
// culling. `expand_bursts` widens each id to its whole burst pile (every live
// frame + each frame's pair companion) — the deliberate "cull the pile in one
// gesture" action; never implicit (cf. lib/bursts.ts).
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { groupExpandCTE } from "@/lib/pairing";
import { burstExpandCTE } from "@/lib/bursts";
import { identityFromHeaders } from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  verdict: z.enum(["pick", "reject", "skip", "unrated"]).optional(),
  star: z.number().int().min(0).max(5).optional(),
  expand_bursts: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { ids, verdict, star, expand_bursts } = parsed.data;
    if (verdict == null && star == null)
      return badRequest("verdict or star required");

    // Cascade each rating so a logical media is rated as one: always to the
    // RAW+JPEG / Live pair companion (cf. lib/pairing.ts); and — only on the
    // explicit pile action — to every live frame of the id's burst stack too.
    const expand = expand_bursts ? burstExpandCTE : groupExpandCTE;
    // Attribution: the account acting is stamped on every touched rating
    // (kept when the identity is somehow absent — cf. migration 0032).
    const userId = identityFromHeaders(req.headers)?.id ?? null;
    await q(
      `WITH ${expand("$1")}
       INSERT INTO ratings (asset_id, verdict, star, reviewed_at, rated_by)
       SELECT id, COALESCE($2,'unrated'), COALESCE($3,0), now(), $4
       FROM target_ids
       ON CONFLICT (asset_id) DO UPDATE SET
         verdict     = COALESCE($2, ratings.verdict),
         star        = COALESCE($3, ratings.star),
         reviewed_at = now(),
         rated_by    = COALESCE($4, ratings.rated_by)`,
      [ids, verdict ?? null, star ?? null, userId],
    );

    await q(
      `WITH ${expand("$1")}
       UPDATE assets SET processing_state = 'triaged', updated_at = now()
       WHERE id IN (SELECT id FROM target_ids) AND processing_state = 'unprocessed'`,
      [ids],
    );

    return json({ updated: ids.length });
  } catch (err) {
    return serverError(err);
  }
}
