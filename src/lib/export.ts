// Export worker (cf. §8). MVP: target `capture_one` = copies the original RAWs
// of the picks to a local export folder. This is the ONLY place where we pull
// large files back over the network. Records the source->export lineage.
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { q, one, many } from "./db";
import { config } from "./config";
import { buildFilter, FilterSchema } from "./filter";
import { partialHash } from "./hash";
import type { Asset } from "./types";

// Atomic + verified copy: we write to a `.part`, check size + partial hash,
// then rename (atomic on the same FS). A crash in progress never leaves a
// partial file under the final name.
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
    throw new Error("copy verification failed (size/hash)");
  }
  await rename(tmp, dest);
}

// Deterministic export folder name derived from the job name. Exported so that
// deleting an export finds the same folder again (cf. api/exports/[id]).
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
  if (!job) throw new Error(`export_job not found: ${exportJobId}`);

  await q("UPDATE export_jobs SET status='running' WHERE id=$1", [exportJobId]);

  try {
    if (job.target !== "capture_one") {
      // web / immich: planned for V2.
      throw new Error(`Export target not yet supported: ${job.target}`);
    }

    const filter = FilterSchema.parse(job.filter_query ?? {});
    const { conditions, params } = buildFilter(filter, 1);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // Pairing: the picks selected in the (collapsed) gallery are the primaries,
    // but which file is the keeper depends on the group kind (cf. lib/pairing.ts):
    //   raw_jpeg   → `raw_jpeg_mode` chooses which files travel: the RAW keeper
    //                only ('raw'), the direct JPEG/HIF only ('jpeg'), or both.
    //   live_photo → keeper is the still primary; the .mov companion (the motion)
    //                tags along only when include_live_video is set.
    // Standalone (unpaired) matches export as-is. Legacy jobs stored only a
    // boolean include_jpeg (true → both, false → raw), so fall back to it.
    const rawJpegMode: "raw" | "both" | "jpeg" =
      job.params?.raw_jpeg_mode === "raw" ||
      job.params?.raw_jpeg_mode === "both" ||
      job.params?.raw_jpeg_mode === "jpeg"
        ? (job.params.raw_jpeg_mode as "raw" | "both" | "jpeg")
        : job.params?.include_jpeg === true
          ? "both"
          : "raw";
    const includeLiveVideo = job.params?.include_live_video === true;
    const modeIdx = params.length + 1;
    const liveIdx = params.length + 2;

    const assets = await many<Asset & { group_kind: string | null }>(
      `WITH matched AS (
         SELECT a.id, a.group_id
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         ${where}
       ),
       grp AS (SELECT DISTINCT group_id FROM matched WHERE group_id IS NOT NULL)
       SELECT a.*, g.kind AS group_kind FROM assets a
       LEFT JOIN asset_groups g ON g.id = a.group_id
       WHERE a.deleted_at IS NULL AND (
              a.id IN (SELECT id FROM matched WHERE group_id IS NULL)
           OR (a.group_id IN (SELECT group_id FROM grp) AND (
                  -- Live Photo: the still is the keeper (always); the .mov motion
                  -- tags along only when include_live_video is set.
                  (g.kind = 'live_photo' AND a.group_role = 'primary')
               OR ($${liveIdx}::boolean AND g.kind = 'live_photo'
                   AND a.group_role = 'companion')
                  -- RAW+JPEG: the RAW companion for 'raw'/'both', the direct
                  -- JPEG/HIF primary for 'jpeg'/'both'.
               OR (g.kind = 'raw_jpeg' AND a.group_role = 'companion'
                   AND $${modeIdx} IN ('raw', 'both'))
               OR (g.kind = 'raw_jpeg' AND a.group_role = 'primary'
                   AND $${modeIdx} IN ('both', 'jpeg'))
              ))
       )
       ORDER BY a.captured_at, a.id`,
      [...params, rawJpegMode, includeLiveVideo],
    );

    const destDir = path.join(config.exportDir, sanitize(job.name));
    await mkdir(destDir, { recursive: true });

    let copied = 0;
    let sidecarsCopied = 0;
    const errors: Array<{ asset_id: number; error: string }> = [];

    for (const asset of assets) {
      const dest = path.join(destDir, asset.filename);
      try {
        await copyVerified(asset.abs_path, dest);
        // Lineage role records which side of the pair this copy is, per group
        // kind: RAW+JPEG → 'raw' (keeper) / 'jpeg'; Live Photo → 'still' (keeper)
        // / 'live_video'; unpaired → 'single'. `kind` stays 'raw_copy' — an
        // original-file copy either way.
        const role =
          asset.group_role == null
            ? "single"
            : asset.group_kind === "live_photo"
              ? asset.group_role === "primary"
                ? "still"
                : "live_video"
              : asset.group_role === "companion"
                ? "raw"
                : "jpeg";
        await q(
          `INSERT INTO exports (source_asset_id, export_job_id, kind, output_path, params)
           VALUES ($1, $2, 'raw_copy', $3, $4)`,
          [asset.id, exportJobId, dest, JSON.stringify({ role })],
        );
        await q(
          "UPDATE assets SET processing_state='exported', updated_at=now() WHERE id=$1",
          [asset.id],
        );
        copied++;

        // Sony video sidecars travel with the clip: copy each next to the
        // exported video (its filename already tracks the clip's name) and
        // record the lineage. A sidecar copy that fails is reported but never
        // discards the video that was already exported above.
        if (asset.media_type === "video") {
          const sidecars = await many<{
            id: number;
            abs_path: string;
            filename: string;
          }>(
            "SELECT id, abs_path, filename FROM asset_sidecars WHERE asset_id = $1",
            [asset.id],
          );
          for (const sc of sidecars) {
            const scDest = path.join(destDir, sc.filename);
            try {
              await copyVerified(sc.abs_path, scDest);
              await q(
                `INSERT INTO exports (source_asset_id, export_job_id, kind, output_path, params)
                 VALUES ($1, $2, 'sidecar', $3, $4)`,
                [
                  asset.id,
                  exportJobId,
                  scDest,
                  JSON.stringify({ role: "sidecar", sidecar_id: sc.id }),
                ],
              );
              sidecarsCopied++;
            } catch (err) {
              errors.push({
                asset_id: asset.id,
                error: `sidecar ${sc.filename}: ${(err as Error).message}`,
              });
            }
          }
        }
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
          sidecars: sidecarsCopied,
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
