// POST /api/pipeline/srt-backfill { force? } -> parses the telemetry of DJI .SRT
// flight-log sidecars already indexed as opaque companions, filling their gps/
// altitude/sample columns and backfilling each clip's location (when it has none
// of its own) + enqueuing a reverse-geocode. The one-click counterpart to
// `npm run srt-backfill`, so a homelab can run it from the Pipeline page without
// a long docker/npm command. Shares lib/srtBackfill.ts with the CLI.
//
// Runs inline: .SRT files are tiny text logs and the only slow step (geocoding)
// is offloaded to the geocode queue, so the request returns with a summary.
import { NextRequest } from "next/server";
import { z } from "zod";
import { runSrtBackfill } from "@/lib/srtBackfill";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  // Re-parse every .srt, not just those not yet parsed (e.g. after a parser fix).
  force: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    // Body is optional; default to the incremental (non-force) pass.
    const raw = await req.json().catch(() => ({}));
    const parsed = Body.safeParse(raw ?? {});
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues);

    const result = await runSrtBackfill({ force: parsed.data.force });
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
