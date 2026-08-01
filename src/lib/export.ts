// Export worker (cf. §8). Two targets, one candidate set:
//   - `capture_one` : copies the picks' originals to a local export folder —
//     the files you go on to develop. The ONLY place where we pull large files
//     back over the network.
//   - `immich`      : uploads them to the Immich library that serves the
//     browsing/phone side, filed in an album (cf. lib/immich.ts) — the shots you
//     go on to look at. Nothing is written locally.
// Both record the same source->export lineage in `exports`; a local copy stores
// its `output_path`, a push stores the remote asset id in `output_key`.
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
import { partialHash, sha1File } from "./hash";
import {
  immichAddToAlbum,
  immichAlbumUrl,
  immichCheckUploads,
  immichConfigured,
  immichFindOrCreateAlbum,
  immichUpload,
} from "./immich";
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
  // Pair identity + capture time. The local copy target ignores both (the file
  // lands under its own name and keeps its mtime); the Immich push needs them
  // to send a real capture date and to re-link a Live Photo's two halves.
  group_id: number | null;
  group_kind: string | null;
  captured_at: Date | null;
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
    group_id: number | null;
    group_kind: string | null;
    group_role: string | null;
    captured_at: Date | null;
  }>(
    `WITH matched AS (
       SELECT a.id, a.group_id
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
     ),
     grp AS (SELECT DISTINCT group_id FROM matched WHERE group_id IS NOT NULL)
     SELECT a.id, a.ext, a.filename, a.abs_path, a.file_size, a.media_type,
            a.group_id, g.kind AS group_kind, a.group_role, a.captured_at
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
      group_id: a.group_id,
      group_kind: a.group_kind,
      captured_at: a.captured_at,
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
        group_id: null,
        group_kind: null,
        captured_at: null,
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

// A queued export, as the worker sees it.
type ExportJobRow = {
  id: number;
  name: string;
  target: string;
  filter_query: unknown;
  params: Record<string, unknown>;
  session_id: number | null;
};

export async function runExportJob(exportJobId: number): Promise<void> {
  const job = await one<ExportJobRow>(
    "SELECT * FROM export_jobs WHERE id = $1",
    [exportJobId],
  );
  if (!job) throw new Error(`export_job not found: ${exportJobId}`);

  await q("UPDATE export_jobs SET status='running' WHERE id=$1", [exportJobId]);

  try {
    // Every target consumes the SAME candidate set: the selection scanned by
    // collectExportFiles (what the modal's plan endpoint showed), narrowed to
    // the categories this job includes. Legacy jobs (no params.include)
    // reproduce the historical behavior exactly.
    const filter = FilterSchema.parse(job.filter_query ?? {});
    const include = includeFromParams(job.params);
    const files = (await collectExportFiles(filter)).filter(
      (f) => include[f.category],
    );

    let result: Record<string, unknown>;
    if (job.target === "capture_one") {
      result = await copyToExportFolder(job, files);
    } else if (job.target === "immich") {
      result = await pushToImmich(job, files);
    } else {
      // `web` (browser-ready renders) is still V2/V3.
      throw new Error(`Export target not yet supported: ${job.target}`);
    }

    await q(
      `UPDATE export_jobs SET status='done', finished_at=now(), result=$2 WHERE id=$1`,
      [exportJobId, JSON.stringify(result)],
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

// --- Target: capture_one ----------------------------------------------------
// Copies the selection's originals into the local export folder. The only place
// where we pull large files back over the network.
async function copyToExportFolder(
  job: ExportJobRow,
  files: ExportFileRow[],
): Promise<Record<string, unknown>> {
  const exportJobId = job.id;
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

  return {
    dest_dir: destDir,
    total: files.filter((f) => f.sidecar_id == null).length,
    copied,
    sidecars: sidecarsCopied,
    errors,
  };
}

// --- Target: immich ---------------------------------------------------------
// Uploads the selection's originals to the Immich library that serves the
// browsing side, and files them in an album. The counterpart of the RAW copy:
// Capture One gets the files to work ON, Immich gets the shots to look AT.
//
// Three things this does NOT do, deliberately:
//   - touch the NAS originals (as everywhere else in Winnow, we only read);
//   - write into Immich's storage/database — everything goes through its public
//     REST API with an API key (cf. lib/immich.ts);
//   - carry sidecars. Immich's upload only accepts an XMP sidecar, and a DJI
//     .SRT flight log or a Sony .XML is not that — those files are skipped and
//     counted in the result rather than failing the job. They still travel with
//     the `capture_one` target, which is where they are actually useful.
async function pushToImmich(
  job: ExportJobRow,
  candidates: ExportFileRow[],
): Promise<Record<string, unknown>> {
  if (!immichConfigured()) {
    throw new Error(
      "Immich push is not configured (set IMMICH_ENABLED=true and IMMICH_API_KEY)",
    );
  }
  const exportJobId = job.id;

  // Sidecars can't travel (see above) — report them instead of erroring.
  const skippedSidecars = candidates.filter((f) => f.sidecar_id != null).length;
  const media = candidates.filter((f) => f.sidecar_id == null);

  // A Live Photo's .mov must exist in Immich BEFORE its still, so the still can
  // reference it and the pair lands as one Live Photo rather than a JPEG plus a
  // stray clip. Sorting is enough: the rest of the order is untouched.
  const files = [
    ...media.filter((f) => f.category === "live_motion"),
    ...media.filter((f) => f.category !== "live_motion"),
  ];

  // Pre-flight: hash everything once and ask Immich what it already holds, so a
  // re-pushed export uploads nothing. Skipped when IMMICH_PRECHECK is off, and
  // never fatal — a failing pre-check just means we upload and let Immich dedup
  // on its side (it returns the existing asset id with status 'duplicate').
  //
  // Hashed one file at a time, for the same reason the upload loop below is
  // sequential: a session can hold thousands of files, and reading them all at
  // once would both thrash the HDD's head and hold thousands of open handles.
  const known = new Map<number, string>(); // file index → existing Immich id
  const checksums = new Map<number, string>();
  if (config.immich.precheck && files.length) {
    try {
      const items: Array<{ id: string; checksum: string }> = [];
      for (const [i, file] of files.entries()) {
        const checksum = await sha1File(file.abs_path);
        checksums.set(i, checksum);
        items.push({ id: String(i), checksum });
      }
      for (const [id, assetId] of await immichCheckUploads(items)) {
        known.set(Number(id), assetId);
      }
    } catch (err) {
      // A file that vanished between the scan and here, or an Immich hiccup:
      // the upload loop reports it per file instead of failing the whole job.
      console.warn(
        `export ${exportJobId}: immich pre-check skipped — ${(err as Error).message}`,
      );
    }
  }

  // Album: resolved ONCE, before any upload, so a bad name/permission fails the
  // job outright instead of after uploading a few gigabytes.
  const albumName =
    config.immich.albumMode === "job"
      ? job.name
      : config.immich.albumMode === "fixed"
        ? config.immich.albumName
        : null;
  const album = albumName ? await immichFindOrCreateAlbum(albumName) : null;

  let uploaded = 0;
  let duplicates = 0;
  const errors: Array<{ asset_id: number; error: string }> = [];
  const albumIds: string[] = [];
  // group_id → the Immich id of that Live Photo's motion clip.
  const liveVideoByGroup = new Map<number, string>();

  // Sequential, like the copy target: the NAS is a single spinning disk and
  // EXPORT_CONCURRENCY already bounds how many jobs run at once. Parallel reads
  // here would cost more in seeks than they'd win in upload overlap.
  for (const [i, file] of files.entries()) {
    try {
      const existing = known.get(i);
      let assetId: string;
      let status: string;

      if (existing) {
        assetId = existing;
        status = "present";
        duplicates++;
      } else {
        // Immich needs a capture date. `captured_at` is EXIF-derived and can be
        // absent (a scan, a screenshot); the file's mtime is the honest
        // fallback, and it is what Immich itself would use.
        const st = await stat(file.abs_path);
        const res = await immichUpload({
          absPath: file.abs_path,
          filename: file.filename,
          createdAt: file.captured_at ?? st.mtime,
          modifiedAt: st.mtime,
          checksum: checksums.get(i),
          livePhotoVideoId:
            file.group_kind === "live_photo" && file.group_id != null
              ? liveVideoByGroup.get(file.group_id)
              : undefined,
        });
        assetId = res.id;
        status = res.status;
        if (res.status === "duplicate") duplicates++;
        else uploaded++;
      }

      if (file.category === "live_motion" && file.group_id != null) {
        liveVideoByGroup.set(file.group_id, assetId);
      }
      albumIds.push(assetId);

      // Lineage: same shape as a local copy, but the output lives on another
      // server — `output_path` stays NULL (nothing to download or delete from
      // here) and `output_key` carries the remote asset id.
      await q(
        `INSERT INTO exports (source_asset_id, export_job_id, kind, output_path, output_key, params)
         VALUES ($1, $2, 'immich', NULL, $3, $4)`,
        [
          file.asset_id,
          exportJobId,
          assetId,
          JSON.stringify({
            role: file.role,
            status,
            album_id: album?.id ?? null,
          }),
        ],
      );
      await q(
        "UPDATE assets SET processing_state='exported', updated_at=now() WHERE id=$1",
        [file.asset_id],
      );
    } catch (err) {
      errors.push({ asset_id: file.asset_id, error: (err as Error).message });
    }
  }

  // Filing into the album happens last, in bulk: an asset already in it comes
  // back as a duplicate (a success for us, cf. lib/immich.ts) so re-pushing an
  // export tops the album up instead of failing.
  const albumErrors =
    album && albumIds.length ? await immichAddToAlbum(album.id, albumIds) : [];

  return {
    server_url: config.immich.baseUrl,
    album_id: album?.id ?? null,
    album_name: album?.albumName ?? null,
    album_url: album ? immichAlbumUrl(album.id) : null,
    total: files.length,
    uploaded,
    duplicates,
    skipped_sidecars: skippedSidecars,
    errors: albumErrors.length
      ? [...errors, { asset_id: 0, error: `album: ${albumErrors.join("; ")}` }]
      : errors,
  };
}
