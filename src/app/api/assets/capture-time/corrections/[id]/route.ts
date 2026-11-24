// GET    /api/assets/capture-time/corrections/:id — the ids it moved ("Show media").
// DELETE /api/assets/capture-time/corrections/:id — Undo: puts back the shift
//        each row had, on the rows this correction still owns; a row a later
//        correction moved again is left and counted (lib/captureCorrections.ts).
import type { NextRequest } from "next/server";
import { json, badRequest, serverError } from "@/lib/api";
import {
  CorrectionError,
  correctionAssetIds,
  movedRows,
  undoCorrection,
} from "@/lib/captureCorrections";

export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await params).id);
    if (id == null) return badRequest("Invalid id");
    return json({ ids: await correctionAssetIds(id) });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await params).id);
    if (id == null) return badRequest("Invalid id");
    const undone = await undoCorrection(id);
    return json({ undone, moved: await movedRows(await correctionAssetIds(id)) });
  } catch (err) {
    if (err instanceof CorrectionError) return badRequest(err.message);
    return serverError(err);
  }
}
