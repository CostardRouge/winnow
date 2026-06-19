// GET /api/export/:id → status + result of an export_job.
import { one } from "@/lib/db";
import { json, notFound, serverError } from "@/lib/api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const job = await one(
      "SELECT * FROM export_jobs WHERE id = $1",
      [Number.parseInt(id, 10)],
    );
    if (!job) return notFound("Export not found");
    return json({ job });
  } catch (err) {
    return serverError(err);
  }
}
