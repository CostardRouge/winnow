// GET  /api/tags            → list of tags + usage count
// POST /api/tags { name, color? } → creates (or returns) a tag
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tags = await many(
      `SELECT t.id, t.name, t.color, count(at.asset_id)::int AS count
       FROM tags t
       LEFT JOIN asset_tags at ON at.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name`,
    );
    return json({ tags });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  name: z.string().trim().min(1).max(64),
  color: z.string().max(32).nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("name required", parsed.error.issues);
    const { name, color } = parsed.data;
    const tag = await one(
      `INSERT INTO tags (name, color) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET color = COALESCE(EXCLUDED.color, tags.color)
       RETURNING id, name, color`,
      [name, color ?? null],
    );
    return json({ tag }, 201);
  } catch (err) {
    return serverError(err);
  }
}
