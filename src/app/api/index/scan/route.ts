// POST /api/index/scan  { path }  → enregistre le root et enfile une indexation.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { enqueueIndex } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({ path: z.string().min(1) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("path requis", parsed.error.issues);

    const root = await one<{ id: number; path: string }>(
      `INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', true)
       ON CONFLICT (path) DO UPDATE SET path = EXCLUDED.path
       RETURNING id, path`,
      [parsed.data.path],
    );
    const jobRef = await enqueueIndex(root!.id);
    return json({ root, job_id: jobRef.id }, 202);
  } catch (err) {
    return serverError(err);
  }
}
