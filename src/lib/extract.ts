// EXIF reading + extraction of the embedded preview (cf. §4 - THE critical point).
// We NEVER decode the RAW sensor: we extract the embedded JPEG preview.
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
  // ExifDateTime / ExifDate from exiftool-vendored
  const anyV = v as { toISOString?: () => string; toString?: () => string };
  if (typeof anyV.toISOString === "function") {
    try {
      return anyV.toISOString();
    } catch {
      /* missing tz */
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
 * Returns the path of a JPEG usable by sharp to generate the derivatives,
 * a possible temporary directory to clean up, and the EXIF orientation (1-8) of
 * the original.
 *
 *  - Directly readable formats (JPEG/PNG/TIFF/WebP/HEIC): we return
 *    the original (sharp handles it, `orientation` not needed).
 *  - RAW: we extract the embedded JPEG preview (JpgFromRaw, otherwise PreviewImage,
 *    otherwise ThumbnailImage) - near-instant extraction, zero demosaicing.
 *    This preview often does NOT carry the Orientation tag: so we return
 *    the orientation read on the RAW so the worker can reapply it.
 */
export async function extractSourceJpeg(
  absPath: string,
  ext: string,
): Promise<{
  jpegPath: string;
  cleanupDir: string | null;
  orientation?: number;
}> {
  const e = ext.toLowerCase();

  // HEIC/HEIF: sharp can decode if libvips has libheif; otherwise we fall back
  // to the preview extraction below. We first try the original for the
  // classic raster formats.
  if (PHOTO_DIRECT_EXTS.has(e) && e !== ".heic" && e !== ".heif") {
    return { jpegPath: absPath, cleanupDir: null };
  }

  // The RAW preview usually loses the Orientation tag: we read it on the RAW.
  const orientation = await readOrientation(absPath);

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
      if (s.size > 0) return { jpegPath: dest, cleanupDir: dir, orientation };
    } catch {
      /* next attempt */
    }
  }

  // Last resort for HEIC: let sharp try the original.
  await rm(dir, { recursive: true, force: true });
  if (e === ".heic" || e === ".heif") {
    return { jpegPath: absPath, cleanupDir: null };
  }
  throw new Error(`No extractable preview from ${absPath}`);
}

// Numeric EXIF orientation (1-8) of the original. `-n` disables exiftool's
// "human" conversion to obtain the raw integer.
async function readOrientation(absPath: string): Promise<number | undefined> {
  try {
    const tags = await exiftool.read(absPath, ["-n"]);
    const o = (tags as { Orientation?: unknown }).Orientation;
    return typeof o === "number" ? o : undefined;
  } catch {
    return undefined;
  }
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}
