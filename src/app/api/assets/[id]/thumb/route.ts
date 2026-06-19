// GET /api/assets/:id/thumb → thumbnail (grid).
import { serveDerivative } from "@/lib/serve";
import { serverError } from "@/lib/api";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await serveDerivative(req, Number.parseInt(id, 10), "thumb");
  } catch (err) {
    return serverError(err);
  }
}
