// GET /api/fs?path=<dir> → subdirectories of <dir>, for the folder picker.
// Navigation is confined to the configured browse roots (cf. lib/fsbrowse.ts);
// omit `path` to get the list of browse roots (the starting locations).
import { NextRequest } from "next/server";
import { listDir, BrowseError } from "@/lib/fsbrowse";
import { json, badRequest, serverError } from "@/lib/api";

// Filesystem-backed: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const path = req.nextUrl.searchParams.get("path") ?? undefined;
    return json(await listDir(path));
  } catch (err) {
    // Guard violations (out of bounds, missing folder) are user-fixable → 400.
    if (err instanceof BrowseError) return badRequest(err.message);
    return serverError(err);
  }
}
