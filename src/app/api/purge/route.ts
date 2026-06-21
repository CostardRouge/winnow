// POST /api/purge { filter?, dryRun? } → reclaim space by physically removing
// the trashed originals + their derivatives. This is the irreversible end of the
// "winnowing", so the UI gates it behind an explicit confirmation.
//
//   - The selection is ALWAYS re-scoped to the trash (soft-deleted, not purged)
//     by the worker, so a purge can never touch a live asset. `filter` narrows
//     it further (default {} = empty the whole trash).
//   - `dryRun: true` returns the exact { count, bytes } that would be freed —
//     used to label the confirmation ("Reclaim 12.4 GB · 318 files").
//   - Otherwise a purge_job is queued and run by the worker (bounded concurrency
//     to spare the NAS HDD); returns { purge_job_id }.
//
// Disable the whole capability with PURGE_ENABLED=false (returns 403).
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { config } from "@/lib/config";
import { enqueuePurge } from "@/lib/queue";
import { buildFilter, FilterSchema } from "@/lib/filter";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({
  filter: FilterSchema.default({}),
  dryRun: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    if (!config.purge.enabled) {
      return json({ error: "Purge is disabled (PURGE_ENABLED=false)" }, 403);
    }

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { filter, dryRun } = parsed.data;

    if (dryRun) {
      const { conditions, params } = buildFilter(filter, 1, { deleted: "trash" });
      const row = await one<{ count: number; bytes: number }>(
        `SELECT count(*)::int AS count, COALESCE(sum(a.file_size), 0) AS bytes
           FROM assets a
           LEFT JOIN ratings r ON r.asset_id = a.id
          WHERE ${conditions.join(" AND ")}`,
        params,
      );
      return json({ count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) });
    }

    const job = await one<{ id: number }>(
      `INSERT INTO purge_jobs (filter_query, status)
       VALUES ($1, 'queued') RETURNING id`,
      [JSON.stringify(filter)],
    );
    await enqueuePurge(job!.id);
    return json({ purge_job_id: job!.id }, 202);
  } catch (err) {
    return serverError(err);
  }
}
