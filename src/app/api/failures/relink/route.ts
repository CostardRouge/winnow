// POST /api/failures/relink { root_id?, apply? } → queue a relink pass over the
// moved originals (cf. lib/relink.ts): match each row whose file went missing to
// the file that now holds its content, and — with `apply` — move the row onto
// it. `apply` defaults to FALSE, so the plain call is a dry run whose report the
// UI shows before anything is written.
//
// GET /api/failures/relink?job_id=N → that job's state and, once it finished,
// the report it returned. The pass walks the whole volume, which is minutes of
// NAS I/O on a spinning disk: far too long for a request, hence a queued job the
// caller polls. It rides the integrity queue (concurrency 1) so a relink and a
// sweep never hammer the disk at once — see lib/queue.ts.
//
// Admin-only by policy, not by a check here: /api/failures is in
// ADMIN_WRITE_PREFIXES (lib/authz.ts), so every mutation under it needs admin.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { enqueueRelink, getRelinkJob } from "@/lib/queue";
import { json, badRequest, notFound, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const jobId = req.nextUrl.searchParams.get("job_id");
    if (!jobId) return badRequest("job_id is required");
    const job = await getRelinkJob(jobId);
    if (!job) return notFound("Relink job not found");
    return json({ job });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  root_id: z.number().int().positive().optional(),
  // Explicit opt-in: everything else about this endpoint is read-only.
  apply: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    // Tolerate an empty body (the common "dry-run everything" call).
    const raw = await req.text();
    const parsed = Body.safeParse(raw ? JSON.parse(raw) : {});
    if (!parsed.success)
      return badRequest("invalid parameters", parsed.error.issues);
    const { root_id, apply } = parsed.data;

    if (root_id != null) {
      const root = await one<{ id: number }>(
        "SELECT id FROM roots WHERE id = $1",
        [root_id],
      );
      if (!root) return badRequest(`unknown root: ${root_id}`);
    }

    const job = await enqueueRelink({ rootId: root_id ?? null, apply });
    return json({ queued: true, job_id: String(job.id), apply: apply === true });
  } catch (err) {
    return serverError(err);
  }
}
