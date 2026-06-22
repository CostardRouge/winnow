// GET /api/sessions/:id/files → the flat manifest of a session's downloadable
// originals: every non-deleted asset as { id, filename }. Lightweight on purpose
// (no derivative/EXIF columns) — it backs the session Download menu's "each file"
// and "save to folder" options, which pull each original through
// /api/assets/:id/download. The whole-session ZIP has its own streaming route.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    if (!Number.isFinite(sessionId)) return badRequest("invalid id");

    const files = await many<{ id: number; filename: string }>(
      `SELECT id, filename
         FROM assets
        WHERE session_id = $1 AND deleted_at IS NULL
        ORDER BY captured_at NULLS LAST, id`,
      [sessionId],
    );

    return json({ files });
  } catch (err) {
    return serverError(err);
  }
}
