// POST /api/failures/duplicates/pairs/resolve { keepDir, dropDir, scope, q,
// rawInGallery, max, exclude } → keeps, in one bounded batch, the copy in
// `keepDir` of every two-copy group living in exactly those two folders
// (lib/duplicatePairs → resolveDuplicatePair).
//
// The body names the two FOLDERS, not a list of groups: the server re-derives
// which groups the pair holds and which copy survives, so a page that went
// stale can never delete a copy outside the pair. `exclude` is the `retry` of
// earlier batches of the same run and can only narrow it. Every group still
// goes through keepOneCopy.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { PairRefused, resolveDuplicatePair } from "@/lib/duplicatePairs";

export const dynamic = "force-dynamic"; // DB-backed route: never pre-rendered/cached at build time

const Body = z.object({
  keepDir: z.string().min(2).max(4096).startsWith("/"),
  dropDir: z.string().min(2).max(4096).startsWith("/"),
  scope: z.enum(["all", "incoming", "gallery", "mixed", "elsewhere"]).default("all"),
  q: z.string().max(500).optional(),
  rawInGallery: z.boolean().optional(),
  max: z.number().int().min(1).max(500).default(100),
  exclude: z.array(z.string().max(200)).max(50_000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);
    return json(await resolveDuplicatePair(parsed.data));
  } catch (err) {
    if (err instanceof PairRefused) return badRequest(err.message);
    return serverError(err);
  }
}
