// POST /api/import/offload { path } → offload d'une carte montée sur l'Optiplex.
// On NE supprime PAS la source (la carte reste intacte).
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { enqueueImport } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({ path: z.string().min(1) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("path requis");

    const batch = await one<{ id: number }>(
      `INSERT INTO import_batches (source_dir, origin) VALUES ($1, 'card_offload')
       RETURNING id`,
      [parsed.data.path],
    );
    await enqueueImport({
      sourceDir: parsed.data.path,
      origin: "card_offload",
      removeAfter: false,
      batchId: batch!.id,
    });
    return json({ batch_id: batch!.id }, 202);
  } catch (err) {
    return serverError(err);
  }
}
