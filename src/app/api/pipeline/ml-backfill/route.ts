// POST /api/pipeline/ml-backfill { force? } -> enqueue an ML job for every asset
// that still needs one: never-analyzed assets, plus — when CLIP is on — assets
// analyzed before CLIP was enabled (ml_status='ready' but no embedding), which
// is what leaves the semantic-search index partially filled. The one-click
// counterpart to `npm run ml-backfill`, sharing lib/ml.prepareMlBackfill with
// the CLI. `force: true` re-enqueues the whole library (container upgrade).
//
// Enqueue-only: the jobs drain through the ml queue at the mlPerHour pace set
// on the Pipeline page, so this returns immediately with the queued count.
import { NextRequest } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { prepareMlBackfill } from "@/lib/ml";
import { enqueueMl } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  force: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    if (!config.ml.enabled) {
      return badRequest("ML analysis is disabled (set ML_ENABLED=true)");
    }

    // Body is optional; default to the incremental (non-force) pass.
    const raw = await req.json().catch(() => ({}));
    const parsed = Body.safeParse(raw ?? {});
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues);

    const ids = await prepareMlBackfill(parsed.data.force ?? false);
    for (const id of ids) await enqueueMl(id);

    return json({ queued: ids.length, clipEnabled: config.ml.clip.enabled });
  } catch (err) {
    return serverError(err);
  }
}
