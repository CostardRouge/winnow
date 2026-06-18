// GET /api/assets/:id/thumb → vignette (grille).
import { serveDerivative } from "@/lib/serve";
import { serverError } from "@/lib/api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await serveDerivative(Number.parseInt(id, 10), "thumb");
  } catch (err) {
    return serverError(err);
  }
}
