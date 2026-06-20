// GET /api/assets/:id/download → downloads the indexed original (abs_path) as an
// attachment. Works for any asset, including those with no derivative yet
// (Pipeline "Pending"): when an item can't be previewed, you can still pull the
// real file to inspect it locally. This (like the export copy) reads the large
// original back over the network, so it's an explicit, on-demand action only.
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
    const assetId = Number.parseInt(id, 10);
    if (!Number.isFinite(assetId)) return badRequest("invalid id");

    const row = await one<{ abs_path: string; filename: string }>(
      "SELECT abs_path, filename FROM assets WHERE id = $1",
      [assetId],
    );
    if (!row) return notFound("Asset not found");

    let size: number;
    try {
      size = (await stat(row.abs_path)).size;
    } catch {
      return notFound("Original file is not reachable");
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
