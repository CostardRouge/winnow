// POST /api/failures/duplicates/delete { paths[] } → hard-deletes the extra
// copies recorded in `duplicate_hits` and clears their audit rows. Unlike the
// asset soft-delete (which only flips deleted_at on an indexed RAW), these files
// were never indexed: the file on disk is the only thing to remove. All the
// safety lives in deleteDuplicateFiles (whitelist + never touch an indexed
// asset + confine to the browsable area); paths that don't pass are reported in
// `skipped` rather than failing the whole batch.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { deleteDuplicateFiles } from "@/lib/duplicates";

const Body = z.object({ paths: z.array(z.string().min(1)).min(1) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);

    const result = await deleteDuplicateFiles(parsed.data.paths);
    return json({ deleted: result.deleted.length, skipped: result.skipped });
  } catch (err) {
    return serverError(err);
  }
}
