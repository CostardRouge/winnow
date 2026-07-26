// POST /api/sessions/:id/restack → re-cluster the session's burst piles from
// scratch with the CURRENT thresholds (BURST_GAP_SECONDS / BURST_MIN_FRAMES).
//
// The scan-time reconciler is deliberately incremental — it never dissolves or
// grows an existing pile — so threshold changes and frames indexed after a pile
// formed only take effect through this explicit action. Non-destructive: piles
// carry no culling state (verdicts/stars/tags are per-asset and survive); only
// membership, order and covers are recomputed. Returns { dissolved, created }.
import { NextRequest } from "next/server";
import { one } from "@/lib/db";
import { restackSession } from "@/lib/bursts";
import { json, badRequest, notFound, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    if (!Number.isFinite(sessionId)) return badRequest("Invalid session id");

    const session = await one<{ id: number }>(
      `SELECT id FROM sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session) return notFound("Session not found");

    const result = await restackSession(sessionId);
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
