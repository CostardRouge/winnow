// Derivatives worker - generates thumbnail (grid) + culling proxy from the preview.
// Writes to storage (disk/MinIO), marks the asset `ready` (cf. §3, §4).
import sharp from "sharp";
import { rm } from "node:fs/promises";
import { q, one } from "./db";
import { config } from "./config";
import { extractSourceJpeg } from "./extract";
import { ffmpegAvailable, makeVideoThumb, makeVideoProxy } from "./video";
import { getStorage } from "./storage/index";
import type { Asset } from "./types";

// sharp reads large previews: we allow very wide images.
sharp.cache(false);
// Cap libvips' per-operation thread pool (defaults to the CPU count). Parallelism
// is already bounded at the job level (DERIVATIVE_CONCURRENCY), so a smaller pool
// avoids dozens of native threads — each with its own glibc malloc arena — from
// fragmenting and pinning the worker's RSS. See SHARP_CONCURRENCY in config.ts.
sharp.concurrency(config.sharpConcurrency);

// Rotation angle (clockwise degrees) for non-mirror EXIF orientations.
// 2/4/5/7 (mirrors) are almost nonexistent in RAW photos -> ignored (0 deg).
const ORIENTATION_ANGLE: Record<number, number> = { 3: 180, 6: 90, 8: 270 };

export async function generateDerivative(assetId: number): Promise<void> {
  const asset = await one<Asset>("SELECT * FROM assets WHERE id = $1", [
    assetId,
  ]);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);
  // Deliberately skipped (Pipeline "Pending" page) or soft-deleted: a job may
  // still be sitting in the queue, but we must not (re)generate anything. Retry/
  // Regenerate reset the status to 'pending', so they are unaffected.
  if (asset.derivative_status === "skipped" || asset.deleted_at) return;
  if (asset.media_type === "video") {
    await generateVideoDerivative(asset);
    return;
  }
  if (asset.processing_state === "ignored") {
    // Session marked ignored after queueing: we generate nothing.
    await q(
      "UPDATE assets SET derivative_status='skipped', updated_at=now() WHERE id=$1",
      [assetId],
    );
    return;
  }

  await q(
    "UPDATE assets SET derivative_status='processing', updated_at=now() WHERE id=$1",
    [assetId],
  );

  let cleanupDir: string | null = null;
  try {
    const src = await extractSourceJpeg(asset.abs_path, asset.ext);
    cleanupDir = src.cleanupDir;

    // Orientation: if the image read by sharp carries its own EXIF tag (direct
    // JPEG, or RAW preview that preserved it), `.rotate()` applies it on its own.
    // Otherwise (frequent case for RAW previews), we explicitly apply the angle
    // derived from the orientation read on the RAW.
    let base = sharp(src.jpegPath, { failOn: "none" });
    const probe = await base.metadata();
    if (probe.orientation && probe.orientation !== 1) {
      base = base.rotate();
    } else {
      const angle = ORIENTATION_ANGLE[src.orientation ?? 1] ?? 0;
      if (angle) base = base.rotate(angle);
    }
    const meta = await base.metadata();

    const thumbKey = `thumb/${assetId}.webp`;
    const proxyKey = `proxy/${assetId}.webp`;

    const thumb = await base
      .clone()
      .resize(config.thumbSize, config.thumbSize, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: config.thumbQuality })
      .toBuffer();

    const proxy = await base
      .clone()
      .resize(config.proxySize, config.proxySize, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: config.proxyQuality })
      .toBuffer();

    const storage = await getStorage();
    await storage.put(thumbKey, thumb, "image/webp");
    await storage.put(proxyKey, proxy, "image/webp");

    await q(
      `UPDATE assets SET
         thumb_key=$2, proxy_key=$3,
         width=COALESCE(width,$4), height=COALESCE(height,$5),
         derivative_status='ready', derivative_error=NULL, updated_at=now()
       WHERE id=$1`,
      [assetId, thumbKey, proxyKey, meta.width ?? null, meta.height ?? null],
    );
  } catch (err) {
    await q(
      "UPDATE assets SET derivative_status='error', derivative_error=$2, updated_at=now() WHERE id=$1",
      [assetId, (err as Error).message?.slice(0, 500) ?? "unknown error"],
    );
    throw err;
  } finally {
    if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
  }
}

// Video derivatives: WebP poster (thumbnail/grid) + replayable mp4 proxy.
async function generateVideoDerivative(asset: Asset): Promise<void> {
  if (asset.processing_state === "ignored") {
    await q(
      "UPDATE assets SET derivative_status='skipped', updated_at=now() WHERE id=$1",
      [asset.id],
    );
    return;
  }
  // ffmpeg missing: we mark the failure (visible in the error list) WITHOUT
  // throwing, to avoid a storm of retries before the image is rebuilt.
  if (!(await ffmpegAvailable())) {
    await q(
      `UPDATE assets SET derivative_status='error',
         derivative_error='ffmpeg not found - rebuild the worker image (see Dockerfile)',
         updated_at=now() WHERE id=$1`,
      [asset.id],
    );
    return;
  }

  await q(
    "UPDATE assets SET derivative_status='processing', updated_at=now() WHERE id=$1",
    [asset.id],
  );

  try {
    const thumbKey = `thumb/${asset.id}.webp`;
    const proxyKey = `proxy/${asset.id}.mp4`;
    const thumb = await makeVideoThumb(asset.abs_path);
    const proxy = await makeVideoProxy(asset.abs_path);
    const storage = await getStorage();
    await storage.put(thumbKey, thumb, "image/webp");
    await storage.put(proxyKey, proxy, "video/mp4");

    await q(
      `UPDATE assets SET
         thumb_key=$2, proxy_key=$3,
         derivative_status='ready', derivative_error=NULL, updated_at=now()
       WHERE id=$1`,
      [asset.id, thumbKey, proxyKey],
    );
  } catch (err) {
    await q(
      "UPDATE assets SET derivative_status='error', derivative_error=$2, updated_at=now() WHERE id=$1",
      [asset.id, (err as Error).message?.slice(0, 500) ?? "unknown error"],
    );
    throw err;
  }
}
