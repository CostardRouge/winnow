// Lecture EXIF + extraction de l'aperçu embarqué (cf. §4 — LE point critique).
// On NE décode JAMAIS le capteur RAW : on extrait l'aperçu JPEG embarqué.
import { exiftool, type Tags } from "exiftool-vendored";
import { tmpdir } from "node:os";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PHOTO_DIRECT_EXTS } from "./config";

export type Metadata = {
  captured_at: string | null;
  camera_model: string | null;
  device: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  aperture: number | null;
  focal_length: number | null;
  gps: { lat: number; lon: number } | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
};

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  // ExifDateTime / ExifDate de exiftool-vendored
  const anyV = v as { toISOString?: () => string; toString?: () => string };
  if (typeof anyV.toISOString === "function") {
    try {
      return anyV.toISOString();
    } catch {
      /* tz manquante */
    }
  }
  return anyV.toString ? anyV.toString() : null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number.parseFloat(m[0]) : null;
}

export async function readMetadata(absPath: string): Promise<Metadata> {
  const t: Tags = await exiftool.read(absPath);
  const make = (t.Make ?? "").toString().trim();
  const model = (t.Model ?? "").toString().trim();
  const device = [make, model].filter(Boolean).join(" ") || null;

  let gps: { lat: number; lon: number } | null = null;
  const lat = num(t.GPSLatitude);
  const lon = num(t.GPSLongitude);
  if (lat != null && lon != null) gps = { lat, lon };

  return {
    captured_at:
      toIso(t.DateTimeOriginal) ??
      toIso(t.SubSecDateTimeOriginal) ??
      toIso(t.CreateDate) ??
      toIso((t as any).MediaCreateDate) ??
      null,
    camera_model: model || null,
    device,
    lens:
      (t.LensModel ?? (t as any).LensID ?? (t as any).Lens ?? null)?.toString() ??
      null,
    iso: num(t.ISO),
    shutter:
      (t.ShutterSpeed ?? t.ExposureTime ?? null)?.toString() ?? null,
    aperture: num(t.FNumber ?? (t as any).Aperture),
    focal_length: num(t.FocalLength),
    gps,
    width: num(t.ImageWidth ?? (t as any).ExifImageWidth),
    height: num(t.ImageHeight ?? (t as any).ExifImageHeight),
    duration_s: num((t as any).Duration ?? (t as any).MediaDuration),
  };
}

/**
 * Retourne le chemin d'un JPEG exploitable par sharp pour générer les dérivés,
 * ainsi qu'un éventuel répertoire temporaire à nettoyer.
 *
 *  - Formats lisibles directement (JPEG/PNG/TIFF/WebP/HEIC) : on renvoie
 *    l'original (sharp s'en charge).
 *  - RAW : on extrait l'aperçu JPEG embarqué (JpgFromRaw, sinon PreviewImage,
 *    sinon ThumbnailImage) — extraction quasi instantanée, zéro dématriçage.
 */
export async function extractSourceJpeg(
  absPath: string,
  ext: string,
): Promise<{ jpegPath: string; cleanupDir: string | null }> {
  const e = ext.toLowerCase();

  // HEIC/HEIF : sharp peut décoder si libvips a libheif ; sinon on tombe sur
  // l'extraction d'aperçu plus bas. On tente d'abord l'original pour les
  // formats matriciels classiques.
  if (PHOTO_DIRECT_EXTS.has(e) && e !== ".heic" && e !== ".heif") {
    return { jpegPath: absPath, cleanupDir: null };
  }

  const dir = await mkdtemp(path.join(tmpdir(), "winnow-"));
  const dest = path.join(dir, "preview.jpg");

  const attempts: Array<() => Promise<void>> = [
    () => exiftool.extractJpgFromRaw(absPath, dest),
    () => exiftool.extractPreview(absPath, dest),
    () => exiftool.extractThumbnail(absPath, dest),
  ];

  for (const attempt of attempts) {
    try {
      await attempt();
      const s = await stat(dest);
      if (s.size > 0) return { jpegPath: dest, cleanupDir: dir };
    } catch {
      /* essai suivant */
    }
  }

  // Dernier recours pour HEIC : laisser sharp tenter l'original.
  await rm(dir, { recursive: true, force: true });
  if (e === ".heic" || e === ".heif") {
    return { jpegPath: absPath, cleanupDir: null };
  }
  throw new Error(`Aucun aperçu extractible depuis ${absPath}`);
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}
