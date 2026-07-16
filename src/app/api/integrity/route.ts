// POST /api/integrity { root_id? } -> enqueues an integrity sweep (cf.
// lib/integrity.ts): re-stats every live original (a source deleted from disk
// funnels into the "Missing files" triage) and verifies the derivative objects
// still exist in storage (a wiped thumb/proxy is re-enqueued for generation).
// `root_id` scopes the sweep to one volume; omitted → the whole library.
// Coalesced like scans: a sweep already queued for the same scope is reused.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { enqueueIntegrity } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  root_id: z.number().int().positive().optional(),
});

export async function POST(req: NextRequest) {
  try {
    // Tolerate an empty body (the common "sweep everything" call).
    const raw = await req.text();
    const parsed = Body.safeParse(raw ? JSON.parse(raw) : {});
    if (!parsed.success)
      return badRequest("invalid parameters", parsed.error.issues);
    const { root_id } = parsed.data;

    if (root_id != null) {
      const root = await one<{ id: number }>(
        "SELECT id FROM roots WHERE id = $1",
        [root_id],
      );
      if (!root) return badRequest(`unknown root: ${root_id}`);
    }

    const job = await enqueueIntegrity({ rootId: root_id ?? null });
    return json({ queued: true, jobId: String(job.id) });
  } catch (err) {
    return serverError(err);
  }
}
