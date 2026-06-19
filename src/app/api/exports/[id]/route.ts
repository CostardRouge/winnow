// DELETE /api/exports/:id → supprime un job d'export :
//   1. (transaction) revert processing_state 'exported' → 'triaged' pour les
//      assets dont la copie est retirée et qui n'ont pas d'autre export, puis
//      suppression des lignes `exports` et du `export_jobs` ;
//   2. (après commit) suppression best-effort des fichiers copiés et du dossier
//      d'export. Les RAW ayant pu être déplacés dans Capture One, une erreur
//      fichier n'est jamais bloquante.
// Ordre voulu : BDD d'abord — on ne supprime jamais de fichiers utilisateur si
// la transaction échoue.
import { NextRequest } from "next/server";
import { rm } from "node:fs/promises";
import path from "node:path";
import { many, one, pool } from "@/lib/db";
import { config } from "@/lib/config";
import { sanitize } from "@/lib/export";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const jobId = Number.parseInt(id, 10);
    if (!Number.isFinite(jobId)) return badRequest("id invalide");

    const job = await one<{ id: number; name: string }>(
      "SELECT id, name FROM export_jobs WHERE id = $1",
      [jobId],
    );
    if (!job) return notFound("Export introuvable");

    const rows = await many<{
      source_asset_id: number;
      output_path: string | null;
    }>("SELECT source_asset_id, output_path FROM exports WHERE export_job_id = $1", [
      jobId,
    ]);
    const assetIds = rows.map((r) => r.source_asset_id);

    // --- 1) BDD en transaction --------------------------------------------
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (assetIds.length) {
        await client.query(
          `UPDATE assets
             SET processing_state = 'triaged', updated_at = now()
           WHERE id = ANY($1)
             AND processing_state = 'exported'
             AND NOT EXISTS (
               SELECT 1 FROM exports e2
               WHERE e2.source_asset_id = assets.id
                 AND e2.export_job_id <> $2)`,
          [assetIds, jobId],
        );
      }
      await client.query("DELETE FROM exports WHERE export_job_id = $1", [jobId]);
      await client.query("DELETE FROM export_jobs WHERE id = $1", [jobId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // --- 2) Fichiers (best-effort, après commit) --------------------------
    const fileErrors: string[] = [];
    for (const r of rows) {
      if (!r.output_path) continue;
      try {
        await rm(r.output_path, { force: true });
      } catch (e) {
        fileErrors.push(`${r.output_path}: ${(e as Error).message}`);
      }
    }
    // Dossier d'export (déterministe d'après le nom du job) : retiré s'il existe.
    try {
      await rm(path.join(config.exportDir, sanitize(job.name)), {
        recursive: true,
        force: true,
      });
    } catch (e) {
      fileErrors.push((e as Error).message);
    }

    return json({ deleted_job: jobId, removed: rows.length, file_errors: fileErrors });
  } catch (err) {
    return serverError(err);
  }
}
