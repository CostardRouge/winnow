// GET /api/sessions/:id/download → streams the whole session as a single ZIP of
// its original files (every non-deleted asset, RAW + JPEG + Live Photo motion
// alike). Mirrors the export download (lib/zip, store-only, starts flowing
// immediately) but reads the indexed originals (assets.abs_path) directly rather
// than copied export output — so you can pull a whole shoot down to inspect it
// locally without ever running the Capture One export.
import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import path from "node:path";
import { one, many } from "@/lib/db";
import { sanitize } from "@/lib/export";
import { createZipStream, type ZipEntry } from "@/lib/zip";
import { badRequest, notFound, serverError } from "@/lib/api";

// Streamed from disk: never pre-rendered/cached at build time.
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
    const sessionId = Number.parseInt(id, 10);
    if (!Number.isFinite(sessionId)) return badRequest("invalid id");

    const session = await one<{ id: number; name: string }>(
      "SELECT id, name FROM sessions WHERE id = $1",
      [sessionId],
    );
    if (!session) return notFound("Session not found");

    const rows = await many<{ abs_path: string; filename: string }>(
      `SELECT abs_path, filename
         FROM assets
        WHERE session_id = $1 AND deleted_at IS NULL
        ORDER BY captured_at NULLS LAST, id`,
      [sessionId],
    );

    const seen = new Map<string, number>();
    const entries: ZipEntry[] = [];

    for (const r of rows) {
      const abs = path.resolve(r.abs_path);
      let mtime: Date | undefined;
      try {
        mtime = (await stat(abs)).mtime;
      } catch {
        continue; // original not reachable (NAS offline, moved): skip it
      }
      // Disambiguate identical filenames coming from different sub-folders.
      const n = seen.get(r.filename) ?? 0;
      seen.set(r.filename, n + 1);
      const name = n === 0 ? r.filename : numbered(r.filename, n);
      entries.push({ name, absPath: abs, mtime });
    }

    if (entries.length === 0) {
      return notFound("No downloadable files in this session");
    }

    const zip = createZipStream(entries);
    return new NextResponse(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(`${sanitize(session.name)}.zip`),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

// "IMG_1234.ARW" → "IMG_1234 (2).ARW"
function numbered(filename: string, n: number): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  return `${base} (${n + 1})${ext}`;
}
