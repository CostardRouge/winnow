// POST /api/export { name, target, filter, params } → creates an export_job + enqueues.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { enqueueExport } from "@/lib/queue";
import { FilterSchema } from "@/lib/filter";
import { EXPORT_CATEGORIES, type ExportCategory } from "@/lib/exportTypes";
import { getSettings } from "@/lib/settings";
import { json, badRequest, serverError } from "@/lib/api";

// Per-category file selection (cf. lib/exportTypes.ts) — what the redesigned
// export modal sends. Optional: legacy callers keep sending raw_jpeg_mode /
// include_jpeg / include_live_video and the worker maps them onto the same
// shape (lib/export.ts includeFromParams).
const IncludeSchema = z
  .object(
    Object.fromEntries(
      EXPORT_CATEGORIES.map((c) => [c, z.boolean().optional()]),
    ) as Record<ExportCategory, z.ZodOptional<z.ZodBoolean>>,
  )
  .strict();

const Body = z.object({
  name: z.string().min(1),
  target: z.enum(["capture_one", "web", "immich"]).default("capture_one"),
  filter: FilterSchema.default({}),
  params: z.record(z.string(), z.unknown()).default({}),
  include: IncludeSchema.optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { name, target, filter, params, include } = parsed.data;

    // Pairing: resolve whether to also copy the companion extras now, so the job
    // is self-contained. An explicit params flag wins; otherwise fall back to the
    // persisted preference (cf. lib/export.ts, lib/settings.ts). `include_jpeg`
    // covers RAW+JPEG pairs (the JPEG next to the RAW keeper); `include_live_video`
    // covers iPhone Live Photos (the .mov motion next to the still keeper).
    const settings = await getSettings();
    const includeLiveVideo =
      typeof include?.live_motion === "boolean"
        ? include.live_motion
        : typeof params.include_live_video === "boolean"
          ? params.include_live_video
          : settings.exportIncludeLiveVideo;

    // RAW+JPEG pairs (Sony .ARW + .HIF, DJI .DNG + .JPG) support three policies:
    // keep the RAW keeper only ('raw'), the direct JPEG/HIF only ('jpeg'), or
    // both ('both'). An explicit `raw_jpeg_mode` wins; otherwise fall back to the
    // legacy `include_jpeg` flag (true → both) or the persisted preference. We
    // keep `include_jpeg` in the stored params in sync so older readers stay
    // coherent (it means "the direct file travels too").
    const rawJpegMode: "raw" | "both" | "jpeg" = include
      ? include.pair_jpeg
        ? include.raw !== false
          ? "both"
          : "jpeg"
        : "raw"
      : params.raw_jpeg_mode === "raw" ||
          params.raw_jpeg_mode === "both" ||
          params.raw_jpeg_mode === "jpeg"
        ? params.raw_jpeg_mode
        : (
              typeof params.include_jpeg === "boolean"
                ? params.include_jpeg
                : settings.exportIncludeJpeg
            )
          ? "both"
          : "raw";
    const includeJpeg = rawJpegMode !== "raw";

    // Associate the job with its session when the export is scoped to one (the
    // per-session "Export picks" flow sets filter.session_id). Ad-hoc gallery
    // exports whose filter spans sessions stay unassociated (NULL). This drives
    // the session's live "export in progress" badge; the persistent
    // export_count / last_exported_at are bumped by the worker on completion.
    const sessionId = filter.session_id ?? null;

    const job = await one<{ id: number }>(
      `INSERT INTO export_jobs (name, target, filter_query, params, status, session_id)
       VALUES ($1, $2, $3, $4, 'queued', $5) RETURNING id`,
      [
        name,
        target,
        JSON.stringify(filter),
        JSON.stringify({
          ...params,
          // The per-category selection is the worker's source of truth when
          // present; the legacy mirrors below keep older readers coherent.
          ...(include ? { include } : {}),
          raw_jpeg_mode: rawJpegMode,
          include_jpeg: includeJpeg,
          include_live_video: includeLiveVideo,
        }),
        sessionId,
      ],
    );
    await enqueueExport(job!.id);
    return json({ export_job_id: job!.id }, 202);
  } catch (err) {
    return serverError(err);
  }
}
