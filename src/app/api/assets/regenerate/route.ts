// POST /api/assets/regenerate { ids[] } -> rebuilds the derivatives (thumb +
// proxy) of the given assets, whatever their current status. Unlike
// /api/failures/retry (which only re-runs assets stuck in 'error'), this is a
// deliberate, user-triggered rebuild — useful after a worker/codec upgrade or to
// fix a bad preview. It resets the assets to 'pending', clears any error, then
// re-enqueues generation. Soft-deleted assets are skipped (RAW untouched).
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, q } from "@/lib/db";
import { enqueueDerivative } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ids required", parsed.error.issues);
    const { ids } = parsed.data;

    const rows = await many<{ id: number }>(
      "SELECT id FROM assets WHERE id = ANY($1) AND deleted_at IS NULL",
      [ids],
    );
    const idList = rows.map((r) => r.id);
    if (idList.length) {
      await q(
        "UPDATE assets SET derivative_status='pending', derivative_error=NULL, updated_at=now() WHERE id = ANY($1)",
        [idList],
      );
      for (const id of idList) await enqueueDerivative(id);
    }
    return json({ queued: idList.length });
  } catch (err) {
    return serverError(err);
  }
}
