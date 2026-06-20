// GET /api/failures/duplicates/file?path=<abs_path> → streams a recorded
// duplicate's file as an attachment, so an extra copy that was never indexed (no
// asset id, no thumbnail) can still be pulled and inspected locally before the
// user decides to delete it. Whitelisted to paths present in `duplicate_hits` so
// it can never be turned into an arbitrary file read. Like the asset download,
// it reads the original back over the network — an explicit, on-demand action.
import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { one } from "@/lib/db";
import { badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

// RFC 5987 / 6266: ASCII fallback + UTF-8 variant so accents survive.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams.get("path");
    if (!p) return badRequest("missing path");

    const row = await one<{ abs_path: string }>(
      "SELECT abs_path FROM duplicate_hits WHERE abs_path = $1",
      [p],
    );
    if (!row) return notFound("Not a recorded duplicate");

    let size: number;
    try {
      size = (await stat(p)).size;
    } catch {
      return notFound("File is not reachable (already moved or deleted)");
    }

    const stream = Readable.toWeb(
      createReadStream(p),
    ) as ReadableStream<Uint8Array>;
    return new NextResponse(stream as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": contentDisposition(path.basename(p)),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
