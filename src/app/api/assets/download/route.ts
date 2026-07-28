// GET /api/assets/download?ids=1,2,3 → streams the selected originals as a
// single ZIP (photos and videos alike), each clip's sidecars riding along.
// Mirrors the whole-session ZIP (api/sessions/:id/download — lib/zip,
// store-only, starts flowing immediately) but takes an explicit id list, so the
// gallery's bulk selection can be pulled down without running an export first.
import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import path from "node:path";
import { many } from "@/lib/db";
import { createZipStream, type ZipEntry } from "@/lib/zip";
import { badRequest, notFound, serverError } from "@/lib/api";

// Streamed from disk: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

// The ids travel in the URL (the ZIP must be a plain navigable link for the
// browser's download tray), so cap the list well below any header size limit.
const MAX_IDS = 1000;

// RFC 5987 / 6266: ASCII fallback + UTF-8 variant so accents survive.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const ids = Array.from(
      new Set(
        (sp.get("ids") ?? "")
          .split(",")
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
    if (ids.length === 0) return badRequest("ids is required");
    if (ids.length > MAX_IDS)
      return badRequest(`too many ids (max ${MAX_IDS})`);

    const rows = await many<{ abs_path: string; filename: string }>(
      `SELECT abs_path, filename
         FROM assets
        WHERE id = ANY($1) AND deleted_at IS NULL
        ORDER BY captured_at NULLS LAST, id`,
      [ids],
    );

    // Video sidecars (Sony XML/THM, DJI drone .SRT) ride along with their clip,
    // exactly as in the whole-session ZIP (cf. lib/sidecars.ts, export.ts).
    const sidecarRows = await many<{ abs_path: string; filename: string }>(
      `SELECT sc.abs_path, sc.filename
         FROM asset_sidecars sc
         JOIN assets a ON a.id = sc.asset_id
        WHERE a.id = ANY($1) AND a.deleted_at IS NULL
        ORDER BY sc.filename, sc.id`,
      [ids],
    );

    const seen = new Map<string, number>();
    const entries: ZipEntry[] = [];

    for (const r of [...rows, ...sidecarRows]) {
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
      return notFound("No downloadable files in this selection");
    }

    const zip = createZipStream(entries);
    return new NextResponse(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition("winnow-selection.zip"),
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
