// POST /api/pipeline/queue/remove { name, jobId } -> drop a single job from the
// scan/analyze queue. Used by the Pipeline triage pages to pull a stuck or
// unwanted item out of the queue. Active (locked) jobs can't be removed
// mid-flight -> { removed: false }.
import { NextRequest } from "next/server";
import { z } from "zod";
import { removeQueueJob } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.enum(["scan", "analyze"]),
  jobId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("name (scan|analyze) and jobId required", parsed.error.issues);
    const { name, jobId } = parsed.data;
    const res = await removeQueueJob(name, jobId);
    return json(res, res.removed ? 200 : 409);
  } catch (err) {
    return serverError(err);
  }
}
