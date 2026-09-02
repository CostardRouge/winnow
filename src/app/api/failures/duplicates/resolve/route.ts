// POST /api/failures/duplicates/resolve { scope, q, rawInGallery, max } →
// collapses, in one batch, every duplicate group in that filter whose survivor
// the rule can pick on its own (cf. resolveDuplicatesAuto): a lone Final/Export
// copy, otherwise the live library copy. Everything else stays manual.
//
// The body carries the FILTER, not a list of groups: the server re-derives which
// groups match and which copy survives with the same code that rendered the
// preview, so a client page that went stale can never delete a copy the rule
// would no longer pick. Each group still goes through keepOneCopy, so the path
// whitelist, the view-only refusal and the relink-before-unlink ordering are
// unchanged.
//
// Bounded per call (`max`, ≤ 500) so the request finishes inside a normal HTTP
// lifetime; the caller loops while `resolved > 0`.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { resolveDuplicatesAuto } from "@/lib/duplicateList";

export const dynamic = "force-dynamic"; // DB-backed route: never pre-rendered/cached at build time

const Body = z.object({
  scope: z.enum(["all", "incoming", "gallery", "mixed", "elsewhere"]).default("all"),
  q: z.string().max(500).optional(),
  rawInGallery: z.boolean().optional(),
  max: z.number().int().min(1).max(500).default(100),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);
    return json(await resolveDuplicatesAuto(parsed.data));
  } catch (err) {
    return serverError(err);
  }
}
