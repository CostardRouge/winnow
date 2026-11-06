// GET /api/sessions/:id/moments → the folder as moments, for the favourites
// pass (docs/FAVOURITES.md §5, lib/sessionMoments.ts). Read-only: the pass
// writes through POST /api/favourites like every other ♥.
import type { NextRequest } from "next/server";
import { loadSessionMoments, TooManyMedia } from "@/lib/sessionMoments";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    if (!Number.isFinite(sessionId)) return badRequest("Invalid id");
    const data = await loadSessionMoments(sessionId);
    if (!data) return notFound("No such folder");
    return json(data);
  } catch (err) {
    if (err instanceof TooManyMedia) return badRequest(err.message);
    return serverError(err);
  }
}
