// /api/failures/duplicates/strategy — a survivor rule the user picks
// (lib/duplicateList → strategyKeep), applied to the current view:
//
//   GET  ?strategy&folder&scope&q&rawInGallery&rule → the preview: groups it
//        decides, files and bytes it would delete, relinks, and the groups it
//        skips by reason. Nothing touches the disk.
//   POST { strategy, folder, scope, q, rawInGallery, rule, max, exclude } →
//        one bounded batch of the run; the caller loops while `remaining`
//        shrinks, sending back each batch's `retry` as `exclude`.
//
// Like every bulk path here, the body carries the FILTER and the strategy,
// never a list of groups or paths: the server re-derives each survivor, and
// every group still goes through keepOneCopy.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { previewStrategy, resolveStrategy } from "@/lib/duplicateList";

export const dynamic = "force-dynamic"; // DB-backed route: never pre-rendered/cached at build time

const Filter = {
  strategy: z.enum(["library", "shortest", "folder"]),
  folder: z.string().max(500).optional(),
  scope: z.enum(["all", "incoming", "gallery", "mixed", "elsewhere"]).default("all"),
  q: z.string().max(500).optional(),
  rule: z.enum(["protected", "library", "manual"]).optional(),
};

const Query = z.object({
  ...Filter,
  rawInGallery: z.coerce.boolean().optional(),
});

const Body = z.object({
  ...Filter,
  rawInGallery: z.boolean().optional(),
  max: z.number().int().min(1).max(500).default(100),
  exclude: z.array(z.string().max(200)).max(50_000).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);
    return json(await previewStrategy(parsed.data));
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);
    return json(await resolveStrategy(parsed.data));
  } catch (err) {
    return serverError(err);
  }
}
