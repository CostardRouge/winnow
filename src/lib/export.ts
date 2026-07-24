// Export worker (cf. §8). MVP: target `capture_one` = copies the originals of
// the picks to a local export folder. This is the ONLY place where we pull
// large files back over the network. Records the source->export lineage.
//
// Which files travel is driven by `params.include` — a per-category map over
// the taxonomy in lib/exportTypes.ts (RAW / photos / videos / pair JPEG / Live
// Photo motion / SRT telemetry / XML+THM metadata). The modal builds it from a
// dynamic scan of the selection (POST /api/export/plan → collectExportFiles);
// legacy jobs that only carry raw_jpeg_mode / include_jpeg / include_live_video
// are mapped onto the same shape, so their behavior is unchanged.
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { q, one, many } from "./db";
import { config, PHOTO_RAW_EXTS } from "./config";
import { buildFilter, FilterSchema, type AssetFilter } from "./filter";
import { partialHash } from "./hash";
import type { ExportCategory, ExportInclude } from "./exportTypes";

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

// One candidate file of an export: a media original/companion (sidecar_id null)
// or a video sidecar. `category` is the picker taxonomy (lib/exportTypes.ts);
// `role` is the legacy lineage label recorded on the exports row.
export type ExportFileRow = {
  asset_id: number;
  sidecar_id: number | null;
  category: ExportCategory;
  ext: string;
  filename: string;
  abs_path: string;
  file_size: number | null;
  role: string;
};

// Where a candidate media file falls in the picker taxonomy. Pure so the
// mapping can be unit-tested without a database.
export function categorizeAsset(a: {
  media_type: string;
  ext: string;
  group_kind: string | null;
  group_role: string | null;
}): ExportCategory {
  if (a.group_kind === "live_photo" && a.group_role === "companion")
    return "live_motion";
  if (a.group_kind === "raw_jpeg" && a.group_role === "primary")
    return "pair_jpeg";
  if (a.media_type === "video") return "video";
  return PHOTO_RAW_EXTS.has(a.ext.toLowerCase()) ? "raw" : "photo";
}

// Legacy lineage role for a media copy (kept stable for existing readers of
// exports.params.role): pairs → raw/jpeg, Live Photos → still/live_video,
// unpaired → single.
function lineageRole(a: {
  group_kind: string | null;
  group_role: string | null;
}): string {
  if (a.group_role == null) return "single";
  if (a.group_kind === "live_photo")
    return a.group_role === "primary" ? "still" : "live_video";
  return a.group_role === "companion" ? "raw" : "jpeg";
}

// Everything the selection COULD export, categorized — the group companions of
// every matched primary and the sidecars of every candidate video, regardless
// of what the user will end up checking. Both the plan endpoint (counts for
// the modal's dynamic scan) and the worker (filtered by include) feed on this,
// so what the modal shows is exactly what the worker considers.
export async function collectExportFiles(
  filter: AssetFilter,
): Promise<ExportFileRow[]> {
  const { conditions, params } = buildFilter(filter, 1);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const assets = await many<{
    id: number;
    ext: string;
    filename: string;
    abs_path: string;
    file_size: number | null;
    media_type: string;
    group_kind: string | null;
    group_role: string | null;
  }>(
    `WITH matched AS (
       SELECT a.id, a.group_id
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
     ),
     grp AS (SELECT DISTINCT group_id FROM matched WHERE group_id IS NOT NULL)
     SELECT a.id, a.ext, a.filename, a.abs_path, a.file_size, a.media_type,
            g.kind AS group_kind, a.group_role
     FROM assets a
     LEFT JOIN asset_groups g ON g.id = a.group_id
     WHERE a.deleted_at IS NULL AND (
            a.id IN (SELECT id FROM matched WHERE group_id IS NULL)
         OR a.group_id IN (SELECT group_id FROM grp)
     )
     ORDER BY a.captured_at, a.id`,
    params,
  );

  const out: ExportFileRow[] = [];
  const videoIds: number[] = [];
  for (const a of assets) {
    out.push({
      asset_id: a.id,
      sidecar_id: null,
      category: categorizeAsset(a),
      ext: a.ext.toLowerCase(),
      filename: a.filename,
      abs_path: a.abs_path,
      file_size: a.file_size,
      role: lineageRole(a),
    });
    if (a.media_type === "video") videoIds.push(a.id);
  }

  // Sidecars of every candidate video, in one round-trip. SRT = drone flight
  // log; XML/THM = camera metadata (cf. lib/sidecars.ts).
  if (videoIds.length) {
    const sidecars = await many<{
      id: number;
      asset_id: number;
      abs_path: string;
      filename: string;
      kind: string;
      file_size: number | null;
    }>(
      `SELECT id, asset_id, abs_path, filename, kind, file_size
         FROM asset_sidecars WHERE asset_id = ANY($1)
        ORDER BY asset_id, id`,
      [videoIds],
    );
    for (const sc of sidecars) {
      out.push({
        asset_id: sc.asset_id,
        sidecar_id: sc.id,
        category: sc.kind === "srt" ? "sidecar_srt" : "sidecar_meta",
        ext: path.extname(sc.filename).toLowerCase(),
        filename: sc.filename,
        abs_path: sc.abs_path,
        file_size: sc.file_size,
        role: "sidecar",
      });
    }
  }
  return out;
}

// Resolve the job's effective include map. Modern jobs carry params.include
// (overlaid onto the legacy-derived base so partial maps stay predictable);
// legacy jobs reproduce today's behavior exactly: originals always travel,
// raw_jpeg_mode decides the two sides of a pair, include_live_video the .mov,
// and sidecars always ride with their clip.
export function includeFromParams(
  params: Record<string, unknown> | null | undefined,
): Record<ExportCategory, boolean> {
  const rawJpegMode: "raw" | "both" | "jpeg" =
    params?.raw_jpeg_mode === "raw" ||
    params?.raw_jpeg_mode === "both" ||
    params?.raw_jpeg_mode === "jpeg"
      ? (params.raw_jpeg_mode as "raw" | "both" | "jpeg")
      : params?.include_jpeg === true
        ? "both"
        : "raw";
  // Note: the legacy 'jpeg' mode only skipped the RAW side of PAIRS (standalone
  // RAWs still exported). The category filter is coarser — raw:false also drops
  // standalone RAWs — which matches the mode's intent ("keep the light files")
  // and only shifts behavior for a re-run legacy 'jpeg' job holding lone RAWs.
  const base: Record<ExportCategory, boolean> = {
    raw: rawJpegMode !== "jpeg",
    photo: true,
    video: true,
    pair_jpeg: rawJpegMode !== "raw",
    live_motion: params?.include_live_video === true,
    sidecar_srt: true,
    sidecar_meta: true,
  };
  const inc = params?.include;
  if (inc && typeof inc === "object") {
    for (const [k, v] of Object.entries(inc as ExportInclude)) {
      if (typeof v === "boolean" && k in base) base[k as ExportCategory] = v;
    }
  }
  return base;
}

export async function runExportJob(exportJobId: number): Promise<void> {
  const job = await one<{
    id: number;
    name: string;
    target: string;
    filter_query: unknown;
    params: Record<string, unknown>;
    session_id: number | null;
  }>("SELECT * FROM export_jobs WHERE id = $1", [exportJobId]);
  if (!job) throw new Error(`export_job not found: ${exportJobId}`);

  await q("UPDATE export_jobs SET status='running' WHERE id=$1", [exportJobId]);

  try {
    if (job.target !== "capture_one") {
      // web / immich: planned for V2.
      throw new Error(`Export target not yet supported: ${job.target}`);
    }

    const filter = FilterSchema.parse(job.filter_query ?? {});

    // Scan the selection's full candidate set (same helper the modal's plan
    // endpoint uses), then keep the categories this job includes. Legacy jobs
    // (no params.include) reproduce the historical behavior exactly.
    const include = includeFromParams(job.params);
    const files = (await collectExportFiles(filter)).filter(
      (f) => include[f.category],
    );

    const destDir = path.join(config.exportDir, sanitize(job.name));
    await mkdir(destDir, { recursive: true });

    let copied = 0;
    let sidecarsCopied = 0;
    const errors: Array<{ asset_id: number; error: string }> = [];

    for (const file of files) {
      const dest = path.join(destDir, file.filename);
      try {
        await copyVerified(file.abs_path, dest);
        if (file.sidecar_id == null) {
          // Media copy. Lineage role records which side of the pair this is
          // (raw/jpeg, still/live_video, single); `kind` stays 'raw_copy'.
          await q(
            `INSERT INTO exports (source_asset_id, export_job_id, kind, output_path, params)
             VALUES ($1, $2, 'raw_copy', $3, $4)`,
            [file.asset_id, exportJobId, dest, JSON.stringify({ role: file.role })],
          );
          await q(
            "UPDATE assets SET processing_state='exported', updated_at=now() WHERE id=$1",
            [file.asset_id],
          );
          copied++;
        } else {
          // Sidecar copy (SRT flight log, XML/THM metadata) next to its clip —
          // its filename already tracks the clip's name. A failure is reported
          // but never discards the media that exported fine.
          await q(
            `INSERT INTO exports (source_asset_id, export_job_id, kind, output_path, params)
             VALUES ($1, $2, 'sidecar', $3, $4)`,
            [
              file.asset_id,
              exportJobId,
              dest,
              JSON.stringify({ role: "sidecar", sidecar_id: file.sidecar_id }),
            ],
          );
          sidecarsCopied++;
        }
      } catch (err) {
        errors.push({
          asset_id: file.asset_id,
          error:
            file.sidecar_id == null
              ? (err as Error).message
              : `sidecar ${file.filename}: ${(err as Error).message}`,
        });
      }
    }
    const mediaTotal = files.filter((f) => f.sidecar_id == null).length;

    await q(
      `UPDATE export_jobs SET status='done', finished_at=now(), result=$2 WHERE id=$1`,
      [
        exportJobId,
        JSON.stringify({
          dest_dir: destDir,
          total: mediaTotal,
          copied,
          sidecars: sidecarsCopied,
          errors,
        }),
      ],
    );

    // Persist the session's export history. The job row + its files may be
    // deleted later (once downloaded), but this counter survives, so the session
    // keeps showing "already exported N times, last on <date>".
    if (job.session_id != null) {
      await q(
        `UPDATE sessions
            SET export_count = export_count + 1, last_exported_at = now()
          WHERE id = $1`,
        [job.session_id],
      );
    }
  } catch (err) {
    await q(
      `UPDATE export_jobs SET status='error', finished_at=now(), result=$2 WHERE id=$1`,
      [exportJobId, JSON.stringify({ error: (err as Error).message })],
    );
    throw err;
  }
}
