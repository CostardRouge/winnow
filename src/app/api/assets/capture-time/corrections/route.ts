// GET /api/assets/capture-time/corrections — every clock correction, newest
// first, with what it moved and whether it was undone (migration 0061).
import { json, serverError } from "@/lib/api";
import { listCorrections } from "@/lib/captureCorrections";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ corrections: await listCorrections(100) });
  } catch (err) {
    return serverError(err);
  }
}
