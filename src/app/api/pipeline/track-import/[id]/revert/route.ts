// POST /api/pipeline/track-import/:id/revert → Undo one applied track import:
// the positions and zones it wrote are taken back (a frame re-placed by hand
// since keeps its new position), the import row goes, and the capture-day
// passes decide those frames again (lib/trackImport.ts). Admin-only by policy.
import { NextRequest } from "next/server";
import { revertTrackImport } from "@/lib/trackImport";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("Invalid id");
    const out = await revertTrackImport(id);
    if (!out.found) return notFound("No such import");
    return json(out);
  } catch (err) {
    return serverError(err);
  }
}
