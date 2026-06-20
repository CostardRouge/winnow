// GET  /api/roots                              -> registered volumes (+ counts)
// POST /api/roots { path, type }                -> registers a directory as a volume
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { enqueueIndex } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";
import { isWalkable, kindForType, normalizeRootPath, validateRootPath } from "@/lib/volumes";
import { config } from "@/lib/config";
import type { Root } from "@/lib/types";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

// Root row enriched with the session/asset counts shown in the Volumes table.
export type RootRow = Root & { session_count: number; asset_count: number };

// Paths seeded from the environment (INCOMING_DIR / FINALS_DIRS / EXPORT_DIR) —
// so the table can flag which volumes come from the project config vs added by
// hand. These four env vars are the "suggested type" per directory.
function seededPaths(): string[] {
  const { incomingDir, finalsDirs } = config.import;
  const all = [incomingDir, ...finalsDirs, config.exportDir].filter(Boolean);
  return all.map((p) => normalizeRootPath(p));
}

export async function GET() {
  try {
    const roots = await many<RootRow>(
      `SELECT r.*,
              COALESCE(s.session_count, 0)::int AS session_count,
              COALESCE(s.asset_count, 0)::int   AS asset_count
       FROM roots r
       LEFT JOIN (
         SELECT se.root_id,
                count(DISTINCT se.id)::int AS session_count,
                count(a.id) FILTER (WHERE a.deleted_at IS NULL)::int AS asset_count
         FROM sessions se
         LEFT JOIN assets a ON a.session_id = se.id
         GROUP BY se.root_id
       ) s ON s.root_id = r.id
       ORDER BY r.added_at DESC`,
    );
    return json({ roots, seeded: seededPaths() });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  path: z.string().min(1),
  // The user-facing "type" of the volume; defaults to Incoming (the common case).
  type: z.enum(["incoming", "final", "export"]).default("incoming"),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { type } = parsed.data;

    // Guard the path against the footgun (/, system dirs, overlaps) before we
    // ever register + enqueue a scan. The existing roots are the overlap set.
    const existing = await many<{ path: string }>("SELECT path FROM roots");
    const guard = validateRootPath(parsed.data.path, existing);
    if (!guard.ok) return badRequest(guard.reason);

    const kind = kindForType(type);
    const root = await one<Root>(
      `INSERT INTO roots (path, kind, watch) VALUES ($1, $2, true)
       ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind, watch = EXCLUDED.watch
       RETURNING *`,
      [guard.path, kind],
    );
    // Only source/finals are walked; an 'export' volume is tracked, not indexed.
    if (root && isWalkable(root.kind)) await enqueueIndex(root.id);
    return json({ root }, 201);
  } catch (err) {
    return serverError(err);
  }
}
