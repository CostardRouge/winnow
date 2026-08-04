// POST /api/people/:id/reassign { asset_ids, target_person_id? } → move the
// faces person :id holds in those assets to another person — the undo for a
// bad merge or a bad automatic match, driven by the multi-select on the person
// detail page. The selection unit is the PHOTO (that's what the grid shows);
// only THIS person's faces in each photo move, other people in frame are
// untouched (cf. lib/people.reassignFaces). Omitting target_person_id detaches
// the faces into a fresh unnamed stack instead — deliberately not a bare
// unassign, which the next backfill sweep would immediately re-match right
// back. Editor-gated by the authz default (mutations = editor).
import { NextRequest } from "next/server";
import { z } from "zod";
import { reassignFaces } from "@/lib/people";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  asset_ids: z.array(z.number().int()).min(1).max(10_000),
  target_person_id: z.number().int().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const personId = Number.parseInt(id, 10);
    if (!Number.isFinite(personId)) return badRequest("Invalid person id");

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return badRequest("asset_ids required", parsed.error.issues);
    const { asset_ids, target_person_id } = parsed.data;
    if (target_person_id === personId) {
      return badRequest("cannot move faces onto the same person");
    }

    const result = await reassignFaces(
      personId,
      asset_ids,
      target_person_id ?? null,
    );
    if (result.moved === 0) {
      return badRequest("none of these assets carry a face of this person");
    }
    return json(result);
  } catch (err) {
    if ((err as Error).message === "person not found") {
      return badRequest("person not found");
    }
    return serverError(err);
  }
}
