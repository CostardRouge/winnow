// POST /api/import/inbox → relance manuelle de l'import de l'inbox
// (dépôts SMB/FTP). La surveillance automatique le fait sinon toute seule.
import { one } from "@/lib/db";
import { config } from "@/lib/config";
import { enqueueImport } from "@/lib/queue";
import { json, serverError } from "@/lib/api";

export async function POST() {
  try {
    const batch = await one<{ id: number }>(
      `INSERT INTO import_batches (source_dir, origin) VALUES ($1, 'inbox')
       RETURNING id`,
      [config.import.inboxDir],
    );
    await enqueueImport({
      sourceDir: config.import.inboxDir,
      origin: "inbox",
      removeAfter: true,
      batchId: batch!.id,
    });
    return json({ batch_id: batch!.id }, 202);
  } catch (err) {
    return serverError(err);
  }
}
