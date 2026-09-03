// DELETE /api/timeline/breaks/:id → removes a forced split; the two chapters
// it separated re-derive as one (or as whatever the cut rule says) next time.
import { NextRequest } from "next/server";
import { q } from "@/lib/db";
import { json, badRequest, notFound, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("bad id");
    const r = await q("DELETE FROM timeline_breaks WHERE id = $1", [id]);
    if (!r.rowCount) return notFound();
    return json({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
