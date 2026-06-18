// GET /api/import/:id → statut d'un lot d'import.
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
    if (!batch) return notFound("Lot d'import introuvable");
    return json({ batch });
  } catch (err) {
    return serverError(err);
  }
}
