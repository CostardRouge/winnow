// GET /api/import/:id → status of an import batch.
import { one } from "@/lib/db";
import { json, notFound, serverError } from "@/lib/api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const batch = await one("SELECT * FROM import_batches WHERE id = $1", [
      Number.parseInt(id, 10),
    ]);
    if (!batch) return notFound("Import batch not found");
    return json({ batch });
  } catch (err) {
    return serverError(err);
  }
}
