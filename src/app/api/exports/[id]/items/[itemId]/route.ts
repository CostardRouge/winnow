// GET /api/exports/:id/items/:itemId → downloads the copied original behind one
// export row (the RAW/file dropped in the export folder), as an attachment.
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { one } from "@/lib/db";
import { config } from "@/lib/config";
import { badRequest, notFound, serverError } from "@/lib/api";

// File streamed from disk: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

// RFC 5987 / 6266: keep a plain ASCII fallback and a UTF-8 variant so accents in
// filenames survive the download dialog.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const { id, itemId } = await params;
    const jobId = Number.parseInt(id, 10);
    const exportId = Number.parseInt(itemId, 10);
    if (!Number.isFinite(jobId) || !Number.isFinite(exportId)) {
      return badRequest("invalid id");
    }

    const row = await one<{ output_path: string | null; filename: string }>(
      `SELECT e.output_path, a.filename
         FROM exports e
         JOIN assets a ON a.id = e.source_asset_id
        WHERE e.id = $1 AND e.export_job_id = $2`,
      [exportId, jobId],
    );
    if (!row) return notFound("Export item not found");
    if (!row.output_path) return notFound("No file for this export item");

    // Defence in depth: only ever serve files that live under the export root,
    // even if a row's path were somehow tampered with.
    const abs = path.resolve(row.output_path);
    const root = path.resolve(config.exportDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return notFound("File outside export folder");
    }

    let size: number;
    try {
      size = (await stat(abs)).size;
    } catch {
      return notFound("File missing on disk");
    }

    const stream = Readable.toWeb(
      createReadStream(abs),
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
