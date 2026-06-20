// POST /api/assets/skip { ids[] } -> takes assets out of the analyze pipeline by
// marking their derivatives 'skipped'. Used by the Pipeline "Pending" page to
// drop items that should not be processed now or by a later scan (incremental
// scans skip already-known files). The guard in generateDerivative honours this,
// so even a job already sitting in the queue becomes a no-op. RAW is untouched;
// the asset can be brought back with Regenerate (which resets it to 'pending').
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
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

    const res = await q(
      `UPDATE assets
          SET derivative_status='skipped', derivative_error=NULL, updated_at=now()
        WHERE id = ANY($1)
          AND derivative_status IN ('pending','processing','error')`,
      [ids],
    );
    return json({ skipped: res.rowCount ?? 0 });
  } catch (err) {
    return serverError(err);
  }
}
