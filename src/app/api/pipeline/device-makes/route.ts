// GET  /api/pipeline/device-makes            -> preview: the bodies whose files
//      gave a Model without the Make the model's other files declare, each
//      with the one full name it would join (lib/deviceMakes.ts), and the
//      models two makers claim, which are left alone.
// POST /api/pipeline/device-makes { apply }  -> join them, with a report.
//
// The backlog half of the join: the indexer runs the same statements at the
// end of every scan for the models it read, so new files join on their own;
// this is for what was indexed before. Inline, because it is database-only —
// no original is read or written. Writes need an admin (/api/pipeline is an
// admin-write prefix, lib/authz.ts).
import { NextRequest } from "next/server";
import { z } from "zod";
import { findMakelessBodies, joinMakelessBodies } from "@/lib/deviceMakes";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await findMakelessBodies());
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({ apply: z.literal(true) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return badRequest("{ apply: true } required", parsed.error.issues);
    return json(await joinMakelessBodies());
  } catch (err) {
    return serverError(err);
  }
}
