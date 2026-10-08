// GET  /api/pipeline/capture-days            → where the library's capture days
//                                              stand (lib/captureDays.ts stats)
// GET  /api/pipeline/capture-days?job_id=N   → that job's state + report
// POST /api/pipeline/capture-days { apply?, reread? } → queue the repair
//
// The repair files every frame on its photographer's LOCAL day (migration
// 0046) instead of its UTC one. `apply` defaults to FALSE: the plain call runs
// the database-only steps in a rolled-back transaction and reports what would
// change. `reread` (apply only) also re-reads the date tags of the rows the
// database cannot classify — the originals' headers, never their bytes beyond
// that, and never a write — at the scan's pace and under its pause.
//
// Admin-only by policy (lib/authz.ts: /api/pipeline mutations are admin).
import { NextRequest } from "next/server";
import { z } from "zod";
import { captureDayStats, NEIGHBOUR_WINDOW_HOURS } from "@/lib/captureDays";
import { enqueueCaptureDays, getCaptureDaysJob } from "@/lib/queue";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const jobId = req.nextUrl.searchParams.get("job_id");
    if (jobId) {
      const job = await getCaptureDaysJob(jobId);
      if (!job) return notFound("Capture-day job not found");
      return json({ job });
    }
    return json({
      stats: await captureDayStats(),
      neighbourWindowHours: NEIGHBOUR_WINDOW_HOURS,
    });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  apply: z.boolean().optional(),
  reread: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    let body: unknown = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return badRequest("invalid JSON body");
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) return badRequest("invalid parameters", parsed.error.issues);
    const job = await enqueueCaptureDays(parsed.data);
    return json({
      queued: true,
      job_id: String(job.id),
      apply: parsed.data.apply === true,
      reread: parsed.data.apply === true && parsed.data.reread === true,
    });
  } catch (err) {
    return serverError(err);
  }
}
