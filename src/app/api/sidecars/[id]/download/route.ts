// GET /api/sidecars/:id/download → downloads a single video sidecar file
// (Sony XML/THM, DJI drone .SRT) as an attachment. Sidecars are not assets — they
// live in `asset_sidecars`, tied to their video clip (cf. lib/sidecars.ts) — so
// they need their own per-file endpoint, mirroring /api/assets/:id/download. This
// backs the session Download menu's "each file" / "save to folder" options and
// the viewer's telemetry download link.
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { one } from "@/lib/db";
import { badRequest, notFound, serverError } from "@/lib/api";

// File streamed from disk: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

// RFC 5987 / 6266: ASCII fallback + UTF-8 variant so accents survive.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sidecarId = Number.parseInt(id, 10);
    if (!Number.isFinite(sidecarId)) return badRequest("invalid id");

    const row = await one<{ abs_path: string; filename: string }>(
      "SELECT abs_path, filename FROM asset_sidecars WHERE id = $1",
      [sidecarId],
    );
    if (!row) return notFound("Sidecar not found");

    let size: number;
    try {
      size = (await stat(row.abs_path)).size;
    } catch {
      return notFound("Sidecar file is not reachable");
    }

    const stream = Readable.toWeb(
      createReadStream(row.abs_path),
    ) as ReadableStream<Uint8Array>;
    return new NextResponse(stream as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": contentDisposition(row.filename),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
