// POST /api/upload  (multipart, champ "files") → upload web depuis le téléphone.
// On écrit dans un sous-dossier de l'inbox puis on enfile l'import.
import { NextRequest } from "next/server";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { one } from "@/lib/db";
import { enqueueImport } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const runtime = "nodejs";
export const maxDuration = 600;

function safeName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_") || "file";
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) return badRequest("Aucun fichier (champ 'files')");

    const batchDir = path.join(
      config.import.inboxDir,
      `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(batchDir, { recursive: true });

    for (const file of files) {
      const dest = path.join(batchDir, safeName(file.name));
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
