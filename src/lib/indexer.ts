// Indexer — scan incrémental d'un root NAS (cf. §3).
// Lecture UNE SEULE FOIS par fichier : métadonnées + hash partiel.
// N'enfile des dérivés QUE pour les assets photo sans dérivé et hors sessions
// ignorées.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { q, one } from "./db";
import { classifyExt } from "./config";
import { partialHash } from "./hash";
import { readMetadata } from "./extract";
import { enqueueDerivative } from "./queue";
import type { Root, Session } from "./types";

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Lecture impossible de ${dir}:`, (err as Error).message);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .DS_Store, dossiers cachés
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function ensureSession(
  root: Root,
  dir: string,
): Promise<Session> {
  const existing = await one<Session>(
    "SELECT * FROM sessions WHERE source_path = $1",
    [dir],
  );
  if (existing) return existing;
  const name = path.relative(root.path, dir) || path.basename(dir) || root.path;
  const row = await one<Session>(
    `INSERT INTO sessions (root_id, name, source_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_path) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [root.id, name, dir],
  );
  return row!;
}

export type IndexResult = {
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  duplicates: number;
  enqueued: number;
  failed: number;
};

export async function indexRoot(rootId: number): Promise<IndexResult> {
  const root = await one<Root>("SELECT * FROM roots WHERE id = $1", [rootId]);
  if (!root) throw new Error(`Root introuvable : ${rootId}`);

  const res: IndexResult = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    duplicates: 0,
    enqueued: 0,
    failed: 0,
  };
  const touchedSessions = new Set<number>();

  for await (const absPath of walk(root.path)) {
    const ext = path.extname(absPath);
    const cls = classifyExt(ext);
    if (!cls) continue; // pas un média reconnu
    res.scanned++;

    // Isolation par fichier : un fichier illisible/corrompu (stat, hash, méta)
    // ne doit pas faire échouer tout le job d'indexation.
    try {
    const st = await stat(absPath);
    const size = st.size;
    const mtime = st.mtime.toISOString();
    const dir = path.dirname(absPath);

    const session = await ensureSession(root, dir);
    touchedSessions.add(session.id);

    const existing = await one<{
      id: number;
      file_size: string | number | null;
      file_mtime: string | null;
    }>("SELECT id, file_size, file_mtime FROM assets WHERE abs_path = $1", [
      absPath,
    ]);

    // Scan incrémental : inchangé (taille + mtime) → on saute.
    if (
      existing &&
      Number(existing.file_size) === size &&
      existing.file_mtime &&
      new Date(existing.file_mtime).getTime() === st.mtime.getTime()
    ) {
      res.skipped++;
      continue;
    }

    const hash = await partialHash(absPath, size);
    const meta = await readMetadata(absPath);
    const capturedAt = meta.captured_at ?? mtime; // toujours peuplé → index utile
    const ignored = session.ignored;

    if (existing) {
      // Fichier modifié : on met à jour et on relance le dérivé si photo.
      const willDerive = cls.mediaType === "photo" && !ignored;
      await q(
        `UPDATE assets SET
           rel_path=$2, filename=$3, ext=$4, media_type=$5, device=$6,
           file_size=$7, file_mtime=$8, content_hash=$9, captured_at=$10,
           camera_model=$11, lens=$12, iso=$13, shutter=$14, aperture=$15,
           focal_length=$16, gps=$17, width=$18, height=$19, duration_s=$20,
           derivative_status=$21,
           processing_state=CASE WHEN $22 THEN 'ignored' ELSE processing_state END,
           updated_at=now()
         WHERE id=$1`,
        [
          existing.id,
          path.relative(root.path, absPath),
          path.basename(absPath),
          ext.toLowerCase(),
          cls.mediaType,
          meta.device,
          size,
          mtime,
          hash,
          capturedAt,
          meta.camera_model,
          meta.lens,
          meta.iso,
          meta.shutter,
          meta.aperture,
          meta.focal_length,
          meta.gps ? JSON.stringify(meta.gps) : null,
          meta.width,
          meta.height,
          meta.duration_s,
          willDerive ? "pending" : "skipped",
          ignored,
        ],
      );
      res.updated++;
      if (willDerive) {
        await enqueueDerivative(existing.id);
        res.enqueued++;
      }
      continue;
    }

    // Nouveau fichier. ON CONFLICT (content_hash) → doublon d'un autre chemin.
    const willDerive = cls.mediaType === "photo" && !ignored;
    const inserted = await one<{ id: number }>(
      `INSERT INTO assets (
         session_id, abs_path, rel_path, filename, ext, media_type, device,
         file_size, file_mtime, content_hash, captured_at, camera_model, lens,
         iso, shutter, aperture, focal_length, gps, width, height, duration_s,
         derivative_status, processing_state
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         $20,$21,$22,$23
       )
       ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        session.id,
        absPath,
        path.relative(root.path, absPath),
        path.basename(absPath),
        ext.toLowerCase(),
        cls.mediaType,
        meta.device,
        size,
        mtime,
        hash,
        capturedAt,
        meta.camera_model,
        meta.lens,
        meta.iso,
        meta.shutter,
        meta.aperture,
        meta.focal_length,
        meta.gps ? JSON.stringify(meta.gps) : null,
        meta.width,
        meta.height,
        meta.duration_s,
        willDerive ? "pending" : "skipped",
        ignored ? "ignored" : "unprocessed",
      ],
    );

    if (!inserted) {
      res.duplicates++; // même content_hash ailleurs : on ne retraite pas
      continue;
    }
    await q(
      "INSERT INTO ratings (asset_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [inserted.id],
    );
    res.inserted++;
    if (willDerive) {
      await enqueueDerivative(inserted.id);
      res.enqueued++;
    }
    } catch (err) {
      res.failed++;
      console.warn(`Indexation impossible de ${absPath}:`, (err as Error).message);
    }
  }

  // Recalcul des compteurs/plages de capture par session touchée.
  for (const sid of touchedSessions) {
    await q(
      `UPDATE sessions s SET
         asset_count = sub.cnt,
         captured_at_min = sub.cmin,
         captured_at_max = sub.cmax,
         device_hint = sub.device,
         indexed_at = now()
       FROM (
         SELECT
           count(*) AS cnt,
           min(captured_at) AS cmin,
           max(captured_at) AS cmax,
           mode() WITHIN GROUP (ORDER BY device) AS device
         FROM assets WHERE session_id = $1
       ) sub
       WHERE s.id = $1`,
      [sid],
    );
  }

  return res;
}
