// GET /api/db/backup/files/:name -> download one of the sidecar's scheduled
// dumps from the read-only mounted backups dir. Admin-only (under the
// /api/db/backup prefix, cf. lib/authz.ts). The name must match the strict
// dump-filename allowlist — that regex (no separators, no free-form dots) is
// the traversal guard; anything else is a 404, mounted dir or not.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { backupFilePath } from "@/lib/backups";
import { notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const filePath = backupFilePath(name);
    if (!filePath) return notFound("No such backup");

    let size: number;
    try {
      const s = await stat(filePath);
      if (!s.isFile()) return notFound("No such backup");
      size = s.size;
    } catch {
      return notFound("No such backup");
    }

    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
