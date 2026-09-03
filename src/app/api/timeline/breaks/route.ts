// GET  /api/timeline/breaks        → every forced split.
// POST /api/timeline/breaks { at } → the media captured at or after `at`
//                                    start a new chapter (the "split" gesture).
//
// A break is a correction on top of the derivation (cf. migration 0040,
// lib/timeline.ts): it costs one row, nothing on assets, and deleting it
// re-glues the two halves on the next request.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const breaks = await many(`SELECT id, at, created_at FROM timeline_breaks ORDER BY at`);
    return json({ breaks });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({ at: z.string().datetime({ offset: true }) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("at (ISO instant) required", parsed.error.issues);
    // Idempotent: splitting twice at the same instant is one split.
    const brk = await one(
      `INSERT INTO timeline_breaks (at) VALUES ($1)
       ON CONFLICT (at) DO UPDATE SET at = EXCLUDED.at
       RETURNING id, at`,
      [parsed.data.at],
    );
    return json({ break: brk }, 201);
  } catch (err) {
    return serverError(err);
  }
}
