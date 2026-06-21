// HEIC double-rotation scan, as a tracked background job.
//   POST -> enqueue a scan (coalesced: one at a time). Returns the job id.
//   GET  -> the current/most-recent scan: state + progress + result, so the page
//           can show live progress and rebuild its state after a navigation.
// The scan runs in the worker (it walks the HEIC originals on the NAS); the fix
// is applied separately via POST /api/assets/regenerate with the affected ids.
import { enqueueHeicRotationScan, getHeicRotationScan } from "@/lib/queue";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await getHeicRotationScan());
  } catch (err) {
    return serverError(err);
  }
}

export async function POST() {
  try {
    const job = await enqueueHeicRotationScan();
    return json({ id: String(job.id), state: "queued" });
  } catch (err) {
    return serverError(err);
  }
}
