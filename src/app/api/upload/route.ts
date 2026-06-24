// POST /api/upload  (multipart, "files" field) -> web upload from the phone, or
// a whole folder / SD-card tree from a desktop.
//
// Each file may carry a relative path in a parallel "paths" field (the browser's
// webkitRelativePath, e.g. "SDCARD/DCIM/100MSDCF/C0001.MP4"). We rebuild that
// sub-tree under the staging batch dir before enqueuing the import, so that:
//   • files that share a basename across folders (100MSDCF/C0001.MP4 vs
//     101MSDCF/C0001.MP4) no longer clobber each other, and
//   • a clip's sidecars (C0001M01.XML, DJI_0001.SRT, …) stay in the same
//     directory as the clip, where the importer's sidecar-carry expects them.
// Without a "paths" entry a file is filed flat by its basename (phone picker).
import { NextRequest } from "next/server";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { one } from "@/lib/db";
import { enqueueImport } from "@/lib/queue";
import { uploadStagingDir } from "@/lib/import";
import { json, badRequest, serverError } from "@/lib/api";

// One path segment → a safe folder/file name. Anything that isn't a tame
// filename char collapses to "_"; an empty result becomes a stable placeholder.
function safeSegment(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_") || "file";
}

// Turn a browser-supplied relative path into a SAFE relative path confined to
// the batch dir: split on either separator, drop "."/".."/empty segments (so no
// traversal escapes the staging dir), sanitise every segment, and cap the depth.
// Returns just the basename when there's no usable directory part.
function safeRelPath(rel: string | undefined, fallbackName: string): string {
  const raw = (rel && rel.length ? rel : fallbackName).split(/[\\/]+/);
  const segs = raw
    .filter((s) => s && s !== "." && s !== "..")
    .slice(-8) // a sane ceiling on nesting depth
    .map(safeSegment);
  if (segs.length === 0) return safeSegment(fallbackName);
  return path.join(...segs);
}

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) return badRequest("No file ('files' field)");

    // Optional parallel array of relative paths, one per file (same order the
    // client appended them). Missing/short → fall back to the file's basename.
    const paths = form.getAll("paths").map((p) => (typeof p === "string" ? p : ""));

    // Hidden staging (.uploads): imported explicitly below as a batch; the
    // inbox watcher ignores it (dot-folder) -> no double import.
    const batchDir = path.join(
      uploadStagingDir,
      `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(batchDir, { recursive: true });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const rel = safeRelPath(paths[i], file.name);
      const dest = path.join(batchDir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await pipeline(
        Readable.fromWeb(file.stream() as any),
        createWriteStream(dest),
      );
    }

    const batch = await one<{ id: number }>(
      `INSERT INTO import_batches (source_dir, origin) VALUES ($1, 'web_upload')
       RETURNING id`,
      [batchDir],
    );
    await enqueueImport({
      sourceDir: batchDir,
      origin: "web_upload",
      removeAfter: true,
      batchId: batch!.id,
    });

    return json({ batch_id: batch!.id, received: files.length }, 202);
  } catch (err) {
    return serverError(err);
  }
}
