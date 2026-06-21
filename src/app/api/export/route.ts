// POST /api/export { name, target, filter, params } → creates an export_job + enqueues.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { enqueueExport } from "@/lib/queue";
import { FilterSchema } from "@/lib/filter";
import { getSettings } from "@/lib/settings";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({
  name: z.string().min(1),
  target: z.enum(["capture_one", "web", "immich"]).default("capture_one"),
  filter: FilterSchema.default({}),
  params: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { name, target, filter, params } = parsed.data;

    // RAW+JPEG pairing: resolve whether to also copy the JPEG companion now, so
    // the job is self-contained. An explicit params.include_jpeg wins; otherwise
    // fall back to the persisted preference (cf. lib/export.ts, lib/settings.ts).
    const includeJpeg =
      typeof params.include_jpeg === "boolean"
        ? params.include_jpeg
        : (await getSettings()).exportIncludeJpeg;

    const job = await one<{ id: number }>(
      `INSERT INTO export_jobs (name, target, filter_query, params, status)
       VALUES ($1, $2, $3, $4, 'queued') RETURNING id`,
      [
        name,
        target,
        JSON.stringify(filter),
        JSON.stringify({ ...params, include_jpeg: includeJpeg }),
      ],
    );
    await enqueueExport(job!.id);
    return json({ export_job_id: job!.id }, 202);
  } catch (err) {
    return serverError(err);
  }
}
