// POST /api/failures/duplicates/discard { assetId } → removes the file of a
// duplicate group's library copy when that copy is already in the trash, and
// stamps its row purged (bytes gone, still hidden — the purge worker's
// contract). This is the escape hatch for a group whose indexed copy was
// soft-deleted: "Keep only this" collapses the whole group, this drops one
// trashed copy and leaves the other extras listed for triage.
//
// All the safety lives in discardTrashedCopy (must be a recorded duplicate with
// another copy on record, must be in the trash — a live library copy is refused
// so no asset is left pointing at nothing — and confined to the browsable area).
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { discardTrashedCopy, DuplicateError } from "@/lib/duplicates";

const Body = z.object({ assetId: z.number().int().positive() });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);

    const r = await discardTrashedCopy(parsed.data.assetId);
    return json(r);
  } catch (err) {
    if (err instanceof DuplicateError) return badRequest(err.message);
    return serverError(err);
  }
}
