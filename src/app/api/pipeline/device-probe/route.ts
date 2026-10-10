// GET  /api/pipeline/device-probe            → how many clips were never read
// GET  /api/pipeline/device-probe?job_id=N   → that job's state, progress, report
// POST /api/pipeline/device-probe            → queue the probe (coalesced)
//
// The probe reads the camera a clip names in its own metadata track (a DJI
// MP4's `djmd` header, lib/djiTrack.ts) for every video whose EXIF names no
// body, and writes it as `device_source = 'embedded'` — beating a vote or a
// hand-fill, never a human override (lib/deviceProbe.ts). Enqueue-only: it
// opens originals, so it runs on the worker at the scan's pace and under its
// pause, and the page polls the job for its report.
//
// Admin-only by policy (lib/authz.ts: /api/pipeline mutations are admin).
import { NextRequest } from "next/server";
import { countUnprobed } from "@/lib/deviceProbe";
import { enqueueDeviceProbe, getDeviceProbeJob } from "@/lib/queue";
import { json, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const jobId = req.nextUrl.searchParams.get("job_id");
    if (jobId) {
      const job = await getDeviceProbeJob(jobId);
      if (!job) return notFound("Probe job not found");
      return json({ job });
    }
    return json({ unprobed: await countUnprobed() });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST() {
  try {
    const job = await enqueueDeviceProbe();
    return json({ queued: true, job_id: String(job.id) });
  } catch (err) {
    return serverError(err);
  }
}
