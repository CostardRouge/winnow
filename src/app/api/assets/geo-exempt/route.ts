// POST /api/assets/geo-exempt { ids[], exempt } -> marks the given assets as
// never needing a GPS position (exempt=true), or puts them back into the
// geotag backlog (exempt=false). Cf. docs/UNPLACED.md §8, migration
// 0042_geo_exempt.
//
// This is the third state of the backlog next to "placed" and "to do": a
// screenshot, a scan or a screen recording will never have a position, and a
// counter that can never reach zero is a counter nobody reads. Exempting
// writes no coordinates and touches nothing else on the row — it only sets
// geo_exempt_at, which `geo_state=todo` (lib/filter.ts) and the Unplaced view
// exclude. Per asset, never per folder: a folder mixes real photographs and
// screenshots, and a folder-wide exemption would hide the former.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  exempt: z.boolean(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("ids and exempt required", parsed.error.issues);
    const { ids, exempt } = parsed.data;

    // Live assets only, like the geotag action. Idempotent: re-exempting keeps
    // the original timestamp (the row already says when it was decided).
    const rows = await many<{ id: number }>(
      exempt
        ? `UPDATE assets SET
             geo_exempt_at = COALESCE(geo_exempt_at, now()), updated_at = now()
           WHERE id = ANY($1) AND deleted_at IS NULL AND purged_at IS NULL
           RETURNING id`
        : `UPDATE assets SET geo_exempt_at = NULL, updated_at = now()
           WHERE id = ANY($1) AND deleted_at IS NULL AND purged_at IS NULL
             AND geo_exempt_at IS NOT NULL
           RETURNING id`,
      [ids],
    );
    return json({ updated: rows.length, exempt });
  } catch (err) {
    return serverError(err);
  }
}
