// POST /api/people/:id/merge { source_id } → fold `source_id` into person :id —
// the fix for the clusterer splitting one real person across two stacks (its
// threshold errs on the side of splitting, cf. lib/people.ts). The target keeps
// its name and cover (adopting the source's when it has none), inherits every
// face, and the centroids fold as a weighted mean so FUTURE faces match the
// merged person. The source person is deleted. Editor-gated by the authz
// default (mutations = editor).
import { NextRequest } from "next/server";
import { z } from "zod";
import { mergePeople } from "@/lib/people";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  source_id: z.number().int(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const targetId = Number.parseInt(id, 10);
    if (!Number.isFinite(targetId)) return badRequest("Invalid person id");

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return badRequest("source_id required", parsed.error.issues);
    const sourceId = parsed.data.source_id;
    if (sourceId === targetId) {
      return badRequest("cannot merge a person into itself");
    }

    await mergePeople(targetId, sourceId);
    return json({ ok: true });
  } catch (err) {
    if ((err as Error).message === "person not found") {
      return badRequest("person not found");
    }
    return serverError(err);
  }
}
