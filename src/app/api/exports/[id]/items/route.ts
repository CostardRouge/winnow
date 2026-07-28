// GET /api/exports/:id/items → the individual files of an export job, with
// enough of each source asset's metadata to drive the reusable media viewer.
// Thumbnails/proxies are served by asset id (the export reuses the source's
// derivatives), so the client renders them via /api/assets/:source_asset_id/*.
import { many } from "@/lib/db";
import { immichAssetUrl } from "@/lib/immich";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

type Row = {
  id: number;
  source_asset_id: number;
  kind: string;
  output_path: string | null;
  output_key: string | null;
  filename: string;
  ext: string | null;
  media_type: "photo" | "video";
  derivative_status: string;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  captured_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  aperture: number | null;
  focal_length: number | null;
  device: string | null;
  gps: { lat: number; lon: number } | null;
  rel_path: string | null;
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const jobId = Number.parseInt(id, 10);
    if (!Number.isFinite(jobId)) return badRequest("invalid id");

    const rows = await many<Row>(
      `SELECT e.id, e.source_asset_id, e.kind, e.output_path, e.output_key,
              a.filename, a.ext, a.media_type, a.derivative_status,
              a.file_size, a.width, a.height, a.duration_s, a.captured_at,
              a.camera_model, a.lens, a.iso, a.shutter, a.aperture,
              a.focal_length, a.device, a.gps, a.rel_path
         FROM exports e
         JOIN assets a ON a.id = e.source_asset_id
        WHERE e.export_job_id = $1
        ORDER BY a.captured_at, e.id`,
      [jobId],
    );

    // Never leak the server-side absolute path: the client only needs to know a
    // file can be downloaded (and downloads it through /items/:itemId).
    // An `immich` row has no local copy — its output_key is the remote asset id,
    // which becomes a deep link into the Immich library instead.
    const items = rows.map(({ output_path, output_key, ...rest }) => ({
      ...rest,
      downloadable: Boolean(output_path),
      remote_url:
        rest.kind === "immich" && output_key ? immichAssetUrl(output_key) : null,
    }));

    return json({ items });
  } catch (err) {
    return serverError(err);
  }
}
