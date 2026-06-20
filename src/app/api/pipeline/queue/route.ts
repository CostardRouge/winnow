// GET /api/pipeline/queue?name=scan|analyze -> the live jobs of a queue, for the
// Pipeline triage pages (Scanning / Pending). Each job is enriched with the DB
// row it points at: scan jobs carry a rootId (-> folder path), analyze jobs an
// assetId (-> filename / media_type).
import { NextRequest } from "next/server";
import { z } from "zod";
import { many } from "@/lib/db";
import { listQueueJobs, type PublicQueueName } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Query = z.enum(["scan", "analyze"]);

export async function GET(req: NextRequest) {
  try {
    const parsed = Query.safeParse(req.nextUrl.searchParams.get("name"));
    if (!parsed.success) return badRequest("name must be scan|analyze");
    const name: PublicQueueName = parsed.data;

    const jobs = await listQueueJobs(name);

    // Enrich in one round-trip: collect the referenced ids, fetch the labels.
    if (name === "scan") {
      const rootIds = [
        ...new Set(
          jobs
            .map((j) => Number(j.data.rootId))
            .filter((n) => Number.isFinite(n)),
        ),
      ];
      const roots = rootIds.length
        ? await many<{ id: number; path: string; kind: string }>(
            "SELECT id, path, kind FROM roots WHERE id = ANY($1)",
            [rootIds],
          )
        : [];
      const byId = new Map(roots.map((r) => [r.id, r]));
      const items = jobs.map((j) => {
        const root = byId.get(Number(j.data.rootId));
        return {
          job_id: j.id,
          state: j.state,
          priority: j.priority,
          attempts: j.attemptsMade,
          timestamp: j.timestamp,
          failed_reason: j.failedReason,
          root_id: Number(j.data.rootId) || null,
          path: root?.path ?? null,
          kind: root?.kind ?? null,
        };
      });
      return json({ name, count: items.length, items });
    }

    // analyze
    const assetIds = [
      ...new Set(
        jobs.map((j) => Number(j.data.assetId)).filter((n) => Number.isFinite(n)),
      ),
    ];
    const assets = assetIds.length
      ? await many<{
          id: number;
          filename: string;
          abs_path: string;
          media_type: string;
          derivative_status: string;
        }>(
          `SELECT id, filename, abs_path, media_type, derivative_status
             FROM assets WHERE id = ANY($1)`,
          [assetIds],
        )
      : [];
    const byId = new Map(assets.map((a) => [a.id, a]));
    const items = jobs.map((j) => {
      const a = byId.get(Number(j.data.assetId));
      return {
        job_id: j.id,
        state: j.state,
        priority: j.priority,
        attempts: j.attemptsMade,
        timestamp: j.timestamp,
        failed_reason: j.failedReason,
        asset_id: Number(j.data.assetId) || null,
        filename: a?.filename ?? null,
        abs_path: a?.abs_path ?? null,
        media_type: a?.media_type ?? null,
        derivative_status: a?.derivative_status ?? null,
      };
    });
    return json({ name, count: items.length, items });
  } catch (err) {
    return serverError(err);
  }
}
