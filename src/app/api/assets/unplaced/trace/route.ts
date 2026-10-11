// "Follow a track…" (docs/UNPLACED.md §11), read-only.
//   GET  ?from=&to=            → { sources } — what a track could be made of
//                                 around the card: the applied GPS imports
//                                 whose kept fixes fall there, and the located
//                                 frames shot then, per camera body.
//   POST { session_id, from, to, imports[], models[] }
//                              → the card's frames matched one by one against
//                                 the chosen sources and grouped in stops.
// A POST only because the chosen sources are a list; nothing is written. The
// write is POST /api/assets/geotag/points, once the human has seen the stops.
// All the logic is in src/lib/unplacedTrace.ts.
import { NextRequest } from "next/server";
import { z } from "zod";
import { traceCard, traceSources } from "@/lib/unplacedTrace";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const instant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "an instant");

export async function GET(req: NextRequest) {
  try {
    const from = req.nextUrl.searchParams.get("from");
    const to = req.nextUrl.searchParams.get("to");
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return badRequest("from and to (instants) required");
    }
    return json({ sources: await traceSources(from, to) });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  session_id: z.number().int(),
  from: instant,
  to: instant,
  imports: z.array(z.number().int()).max(50).default([]),
  models: z.array(z.string().nullable()).max(50).default([]),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("session_id, from, to required", parsed.error.issues);
    const b = parsed.data;
    return json(
      await traceCard({
        sessionId: b.session_id,
        from: b.from,
        to: b.to,
        imports: b.imports,
        models: b.models,
      }),
    );
  } catch (err) {
    return serverError(err);
  }
}
