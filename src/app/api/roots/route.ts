// GET  /api/roots                          -> registered folders (sources + finals)
// POST /api/roots { path, kind, watch }     -> registers a directory
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { enqueueIndex } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";
import type { Root } from "@/lib/types";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const roots = await many<Root>(
      "SELECT * FROM roots ORDER BY added_at DESC",
    );
    return json({ roots });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  path: z.string().min(1),
  kind: z.enum(["source", "finals"]).default("source"),
  watch: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { path, kind, watch } = parsed.data;
    const root = await one<Root>(
      `INSERT INTO roots (path, kind, watch) VALUES ($1, $2, $3)
       ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind, watch = EXCLUDED.watch
       RETURNING *`,
      [path, kind, watch],
    );
    // Sources AND finals are indexed (the finals to generate their thumbnails,
    // so they can be browsed). The inbox is never registered via this route.
    await enqueueIndex(root!.id);
    return json({ root }, 201);
  } catch (err) {
    return serverError(err);
  }
}
