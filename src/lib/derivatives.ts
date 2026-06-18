// Worker dérivés — génère thumbnail (grille) + proxie de tri depuis l'aperçu.
// Écrit dans le stockage (disque/MinIO), marque l'asset `ready` (cf. §3, §4).
import sharp from "sharp";
import { rm } from "node:fs/promises";
import { q, one } from "./db";
import { config } from "./config";
import { extractSourceJpeg } from "./extract";
import { getStorage } from "./storage/index";
import type { Asset } from "./types";

// sharp lit de gros aperçus : on autorise des images très larges.
sharp.cache(false);

export async function generateDerivative(assetId: number): Promise<void> {
  const asset = await one<Asset>("SELECT * FROM assets WHERE id = $1", [
    assetId,
  ]);
  if (!asset) throw new Error(`Asset introuvable : ${assetId}`);
  if (asset.media_type !== "photo") {
    // MVP : photos uniquement. La vidéo (FFmpeg) viendra en V3.
    await q(
      "UPDATE assets SET derivative_status='skipped', updated_at=now() WHERE id=$1",
      [assetId],
    );
    return;
  }
  if (asset.processing_state === "ignored") {
    // Session marquée ignorée après l'enfilement : on ne génère rien.
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

    const base = sharp(src.jpegPath, { failOn: "none" }).rotate(); // EXIF orient.
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
      [assetId, (err as Error).message?.slice(0, 500) ?? "erreur inconnue"],
    );
    throw err;
  } finally {
    if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
  }
}
