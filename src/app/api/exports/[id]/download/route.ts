// GET /api/exports/:id/download → streams the whole export job as a single ZIP
// of its copied originals. Built on a hand-rolled store-only archiver (lib/zip),
// so there is no extra dependency and the download starts flowing immediately.
import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import path from "node:path";
import { one, many } from "@/lib/db";
import { config } from "@/lib/config";
import { sanitize } from "@/lib/export";
import { createZipStream, type ZipEntry } from "@/lib/zip";
import { badRequest, notFound, serverError } from "@/lib/api";

// Streamed from disk: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

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
    const jobId = Number.parseInt(id, 10);
    if (!Number.isFinite(jobId)) return badRequest("invalid id");

    const job = await one<{ id: number; name: string }>(
      "SELECT id, name FROM export_jobs WHERE id = $1",
      [jobId],
    );
    if (!job) return notFound("Export not found");

    const rows = await many<{ output_path: string | null; filename: string }>(
      `SELECT e.output_path, a.filename
         FROM exports e
         JOIN assets a ON a.id = e.source_asset_id
        WHERE e.export_job_id = $1
        ORDER BY a.captured_at, e.id`,
      [jobId],
    );

    const root = path.resolve(config.exportDir);
    const seen = new Map<string, number>();
    const entries: ZipEntry[] = [];

    for (const r of rows) {
      if (!r.output_path) continue;
      const abs = path.resolve(r.output_path);
      if (abs !== root && !abs.startsWith(root + path.sep)) continue;
      let mtime: Date | undefined;
      try {
        mtime = (await stat(abs)).mtime;
      } catch {
        continue; // copied file gone (moved in Capture One): skip it
      }
      // Disambiguate identical filenames coming from different sessions.
      const n = seen.get(r.filename) ?? 0;
      seen.set(r.filename, n + 1);
      const name = n === 0 ? r.filename : numbered(r.filename, n);
      entries.push({ name, absPath: abs, mtime });
    }

    if (entries.length === 0) {
      return notFound("No downloadable files in this export");
    }

    const zip = createZipStream(entries);
    return new NextResponse(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(`${sanitize(job.name)}.zip`),
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
