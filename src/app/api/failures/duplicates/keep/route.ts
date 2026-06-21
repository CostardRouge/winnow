// POST /api/failures/duplicates/keep { contentHash, keepPath } → collapse a
// group of byte-identical copies down to the single copy the user picked. If the
// survivor is an on-disk copy, the library asset is relinked onto it (preserving
// its id/rating/tags/derivatives) and the former original is removed; if it's the
// indexed copy, only the recorded on-disk extras are removed. All the safety
// (eligible members re-derived from the DB, containment checks, false collisions
// excluded) lives in keepOneCopy.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { keepOneCopy, DuplicateError } from "@/lib/duplicates";

const Body = z.object({
  contentHash: z.string().min(1),
  keepPath: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);

    const r = await keepOneCopy(parsed.data);
    return json({
      kept: r.kept,
      deleted: r.deleted.length,
      relinked: r.relinked,
      skipped: r.skipped,
    });
  } catch (err) {
    if (err instanceof DuplicateError) return badRequest(err.message);
    return serverError(err);
  }
}
