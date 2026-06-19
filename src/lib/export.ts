// Export worker (cf. §8). MVP : cible `capture_one` = copie des RAW originaux
// des picks vers un dossier d'export local. C'est le SEUL endroit où l'on
// rapatrie de gros fichiers sur le réseau. Enregistre le lignage source→export.
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { q, one, many } from "./db";
import { config } from "./config";
import { buildFilter, FilterSchema } from "./filter";
import { partialHash } from "./hash";
import type { Asset } from "./types";

// Copie atomique + vérifiée : on écrit dans un `.part`, on contrôle taille+hash
// partiel, puis on renomme (atomique sur le même FS). Un crash en cours ne
// laisse jamais un fichier partiel sous le nom final.
async function copyVerified(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.part`;
  await rm(tmp, { force: true });
  await copyFile(src, tmp);
  const [srcSt, tmpSt] = await Promise.all([stat(src), stat(tmp)]);
  const [srcHash, tmpHash] = await Promise.all([
    partialHash(src, srcSt.size),
    partialHash(tmp, tmpSt.size),
  ]);
  if (tmpSt.size !== srcSt.size || tmpHash !== srcHash) {
    await rm(tmp, { force: true });
    throw new Error("vérification de copie échouée (taille/hash)");
  }
  await rename(tmp, dest);
}

// Nom de dossier d'export déterministe à partir du nom de job. Exporté pour que
// la suppression d'un export retrouve le même dossier (cf. api/exports/[id]).
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "export";
}

export async function runExportJob(exportJobId: number): Promise<void> {
  const job = await one<{
    id: number;
    name: string;
    target: string;
    filter_query: unknown;
    params: Record<string, unknown>;
  }>("SELECT * FROM export_jobs WHERE id = $1", [exportJobId]);
  if (!job) throw new Error(`export_job introuvable : ${exportJobId}`);

  await q("UPDATE export_jobs SET status='running' WHERE id=$1", [exportJobId]);

  try {
    if (job.target !== "capture_one") {
      // web / immich : prévus en V2.
      throw new Error(`Cible d'export non encore supportée : ${job.target}`);
    }

    const filter = FilterSchema.parse(job.filter_query ?? {});
    const { conditions, params } = buildFilter(filter, 1);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const assets = await many<Asset>(
      `SELECT a.* FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
       ORDER BY a.captured_at, a.id`,
      params,
    );

    const destDir = path.join(config.exportDir, sanitize(job.name));
    await mkdir(destDir, { recursive: true });

    let copied = 0;
    const errors: Array<{ asset_id: number; error: string }> = [];

    for (const asset of assets) {
      const dest = path.join(destDir, asset.filename);
      try {
        await copyVerified(asset.abs_path, dest);
        await q(
          `INSERT INTO exports (source_asset_id, export_job_id, kind, output_path, params)
           VALUES ($1, $2, 'raw_copy', $3, $4)`,
          [asset.id, exportJobId, dest, JSON.stringify({})],
        );
        await q(
          "UPDATE assets SET processing_state='exported', updated_at=now() WHERE id=$1",
          [asset.id],
        );
        copied++;
      } catch (err) {
        errors.push({ asset_id: asset.id, error: (err as Error).message });
      }
    }

    await q(
      `UPDATE export_jobs SET status='done', finished_at=now(), result=$2 WHERE id=$1`,
      [
        exportJobId,
        JSON.stringify({
          dest_dir: destDir,
          total: assets.length,
          copied,
          errors,
        }),
      ],
    );
  } catch (err) {
    await q(
      `UPDATE export_jobs SET status='error', finished_at=now(), result=$2 WHERE id=$1`,
      [exportJobId, JSON.stringify({ error: (err as Error).message })],
    );
    throw err;
  }
}
