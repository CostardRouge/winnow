// POST /api/index/scan  { path }  → registers the root and enqueues an indexing job.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { enqueueIndex } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";
import { validateRootPath } from "@/lib/volumes";

const Body = z.object({ path: z.string().min(1) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("path required", parsed.error.issues);

    // Same guards as /api/roots: never let "/" (or a system dir / an overlap)
    // turn into a whole-filesystem walk.
    const existing = await many<{ path: string }>("SELECT path FROM roots");
    const guard = validateRootPath(parsed.data.path, existing);
    if (!guard.ok) return badRequest(guard.reason);

    const root = await one<{ id: number; path: string }>(
      `INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', true)
       ON CONFLICT (path) DO UPDATE SET path = EXCLUDED.path
       RETURNING id, path`,
      [guard.path],
    );
    const jobRef = await enqueueIndex(root!.id);
    return json({ root, job_id: jobRef.id }, 202);
  } catch (err) {
    return serverError(err);
  }
}
