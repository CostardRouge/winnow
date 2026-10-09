// GET  /api/pipeline/mirror-repair            -> preview: the placed groups the
//      GPS write-back mirrored, judged against the cameras' own fixes of the
//      same hours, with what applying would correct and rewrite.
// POST /api/pipeline/mirror-repair { apply }  -> apply it (lib/mirrorRepair.ts).
//
// The one-click repair for docs/SILENT-LIMITS-AUDIT.md G1, shaped like the
// other pipeline repairs: inline, because the corrections are database-only;
// the originals are rewritten through the gpswrite queue at its own rate, so
// the request returns with a summary. Writes need an admin (/api/pipeline is
// an admin-write prefix, lib/authz.ts).
import { NextRequest } from "next/server";
import { z } from "zod";
import { repairMirrored } from "@/lib/mirrorRepair";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await repairMirrored(false));
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({ apply: z.literal(true) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return badRequest("{ apply: true } required", parsed.error.issues);
    return json(await repairMirrored(true));
  } catch (err) {
    return serverError(err);
  }
}
