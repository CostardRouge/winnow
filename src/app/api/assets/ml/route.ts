// POST /api/assets/ml { ids[] } -> (re)runs the ML analysis (face detection +
// OCR, cf. lib/ml.ts) for the given assets, on demand. This is the manual
// counterpart to the batch backfill — the "Detect faces & text" action in the
// media menus / bulk bar — e.g. to re-analyze after a container/model upgrade.
//
// Only live assets whose derivative exists are enqueued (the analysis feeds on
// the proxy/poster, never the RAW); the rest are reported as `skipped`. Mirrors
// /api/assets/geocode: reset status to 'pending', clear any error, then enqueue.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, q } from "@/lib/db";
import { config } from "@/lib/config";
import { enqueueMl } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
});

export async function POST(req: NextRequest) {
  try {
    if (!config.ml.enabled) {
      return badRequest(
        "ML analysis is disabled (set ML_ENABLED=true and point ML_BASE_URL at your container)",
      );
    }
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ids required", parsed.error.issues);
    const { ids } = parsed.data;

    // Analyzable = live + a derivative to feed the models (photo proxy, or the
    // poster for a video).
    const rows = await many<{ id: number }>(
      `SELECT id FROM assets
       WHERE id = ANY($1) AND deleted_at IS NULL
         AND (CASE WHEN media_type = 'video' THEN thumb_key
                   ELSE COALESCE(proxy_key, thumb_key) END) IS NOT NULL`,
      [ids],
    );
    const idList = rows.map((r) => r.id);
    if (idList.length) {
      await q(
        "UPDATE assets SET ml_status='pending', ml_error=NULL, updated_at=now() WHERE id = ANY($1)",
        [idList],
      );
      for (const id of idList) await enqueueMl(id);
    }
    return json({ queued: idList.length, skipped: ids.length - idList.length });
  } catch (err) {
    return serverError(err);
  }
}
