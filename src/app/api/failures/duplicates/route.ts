// GET /api/failures/duplicates -> the deduplication triage listing: copies
// grouped by content, classified by zone (Incoming / Gallery / Export), filtered
// and paginated server-side.
//
// Its own endpoint rather than a slice of /api/failures: that payload is polled
// every 5 s by EVERY failure family page, and the duplicate list is the one
// family that can hold thousands of rows — carrying it around cost every other
// tab a few hundred kilobytes per tick to render a list nobody was looking at.
// Here the page asks for the forty groups it draws, and reloads only when it
// changes filter or acts.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { listDuplicateGroups } from "@/lib/duplicateList";

export const dynamic = "force-dynamic"; // DB-backed route: never pre-rendered/cached at build time

const Query = z.object({
  scope: z.enum(["all", "incoming", "gallery", "mixed", "elsewhere"]).default("all"),
  q: z.string().max(500).optional(),
  rawInGallery: z.coerce.boolean().optional(),
  sort: z.enum(["size", "recent", "path"]).default("size"),
  limit: z.coerce.number().int().min(1).max(200).default(40),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: NextRequest) {
  try {
    const parsed = Query.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);
    return json(await listDuplicateGroups(parsed.data));
  } catch (err) {
    return serverError(err);
  }
}
