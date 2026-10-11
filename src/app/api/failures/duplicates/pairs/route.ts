// GET /api/failures/duplicates/pairs -> the deduplication backlog by FOLDER
// PAIR: two-copy groups aggregated by the two folders they live in, biggest
// first (lib/duplicatePairs). Same filter as the group listing (scope, path,
// RAW in Gallery), paged server-side.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { listDuplicatePairs } from "@/lib/duplicatePairs";

export const dynamic = "force-dynamic"; // DB-backed route: never pre-rendered/cached at build time

const Query = z.object({
  scope: z.enum(["all", "incoming", "gallery", "mixed", "elsewhere"]).default("all"),
  q: z.string().max(500).optional(),
  rawInGallery: z.coerce.boolean().optional(),
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
    return json(await listDuplicatePairs(parsed.data));
  } catch (err) {
    return serverError(err);
  }
}
