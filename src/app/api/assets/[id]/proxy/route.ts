// GET /api/assets/:id/proxy -> culling proxy (detail/zoom view).
import { serveDerivative } from "@/lib/serve";
import { serverError } from "@/lib/api";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await serveDerivative(req, Number.parseInt(id, 10), "proxy");
  } catch (err) {
    return serverError(err);
  }
}
