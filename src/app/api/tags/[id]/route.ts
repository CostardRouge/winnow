// DELETE /api/tags/:id → supprime le tag (cascade sur asset_tags).
import { q } from "@/lib/db";
import { json, serverError } from "@/lib/api";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await q("DELETE FROM tags WHERE id = $1", [Number.parseInt(id, 10)]);
    return json({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
