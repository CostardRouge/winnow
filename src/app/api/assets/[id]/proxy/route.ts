// GET /api/assets/:id/proxy → proxie de tri (vue détail/zoom).
import { serveDerivative } from "@/lib/serve";
import { serverError } from "@/lib/api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return await serveDerivative(Number.parseInt(id, 10), "proxy");
  } catch (err) {
    return serverError(err);
  }
}
