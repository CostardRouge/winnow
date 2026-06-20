// EXIF reading + extraction of the embedded preview (cf. §4 - THE critical point).
// We NEVER decode the RAW sensor: we extract the embedded JPEG preview.
import { exiftool, type Tags } from "exiftool-vendored";
import heicConvert from "heic-convert";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HEIC_EXTS, PHOTO_DIRECT_EXTS } from "./config";

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
  // ExifDateTime / ExifDate from exiftool-vendored expose toISOString(). When the
  // tag holds an unparseable value (e.g. a device with no real-time clock writes
  // the placeholder "0000:00:00 00:00:00"), the library hands back the raw string
  // instead, so we normalize/validate every candidate below.
  const anyV = v as { toISOString?: () => string; toString?: () => string };
  if (typeof anyV.toISOString === "function") {
    try {
      const iso = normalizeTimestamp(anyV.toISOString());
      if (iso) return iso;
    } catch {
      /* missing tz → fall back to the raw string form */
    }
  }
  return normalizeTimestamp(typeof v === "string" ? v : anyV.toString?.());
}

// Coerce an EXIF/ISO date candidate into a Postgres-acceptable timestamp, or
// null when it isn't a real instant. EXIF stores dates as "YYYY:MM:DD HH:MM:SS";
// Postgres rejects the colon date separators, and devices without a clock emit
// an all-zero placeholder that must never reach a TIMESTAMPTZ column.
function normalizeTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Reject zero/placeholder dates (year 0000, month 00 or day 00) up front.
  const m = s.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
  if (m && (m[1] === "0000" || m[2] === "00" || m[3] === "00")) return null;
  // Rewrite EXIF colon date separators to ISO hyphens; already-ISO strings (with
  // hyphens, "T", or a zone offset) are left untouched.
  const iso = s.replace(/^(\d{4}):(\d{2}):(\d{2})([ T])/, "$1-$2-$3$4");
  // Final guard: drop anything that isn't a parseable instant.
  return Number.isFinite(Date.parse(iso)) ? iso : null;
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
 *  - Directly readable formats (JPEG/PNG/TIFF/WebP/AVIF): we return
 *    the original (sharp handles it, `orientation` not needed).
 *  - HEIF/HEVC stills (.heic/.heif/.hif): sharp's prebuilt libvips ships the
 *    AVIF decoder but NOT the HEVC one, and these files rarely embed an
 *    extractable JPEG preview, so we decode them via libheif (heic-convert) to a
 *    temporary JPEG.
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

  // Raster formats sharp decodes natively (JPEG/PNG/TIFF/WebP/AVIF): pass through.
  if (PHOTO_DIRECT_EXTS.has(e) && !HEIC_EXTS.has(e)) {
    return { jpegPath: absPath, cleanupDir: null };
  }

  // HEIF/HEVC stills: decode via libheif to a temporary JPEG. libheif applies
  // the irot/imir transforms but NOT the EXIF Orientation, so we carry the
  // latter over and let the worker re-apply it (same as for RAW previews).
  if (HEIC_EXTS.has(e)) {
    const orientation = await readOrientation(absPath);
    const dir = await mkdtemp(path.join(tmpdir(), "winnow-"));
    const dest = path.join(dir, "decoded.jpg");
    try {
      const input = await readFile(absPath);
      // heic-convert (via heic-decode) sniffs the HEIF brand with
      // `String.fromCharCode(...buf.slice(8, 12))`, which needs an *iterable*
      // byte container. A raw ArrayBuffer is NOT iterable, so handing one over
      // throws "Spread syntax requires ...iterable[Symbol.iterator] to be a
      // function" before any decoding happens. The Buffer from readFile is
      // already a correct (offset/length-aware) view, so we pass it straight
      // through. The published @types claim `ArrayBufferLike`, which is wrong
      // for the runtime — hence the cast.
      const jpeg = await heicConvert({
        buffer: input as unknown as ArrayBufferLike,
        format: "JPEG",
      });
      await writeFile(dest, Buffer.from(jpeg));
      return { jpegPath: dest, cleanupDir: dir, orientation };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        `HEIF decode failed for ${absPath}: ${(err as Error).message}`,
      );
    }
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

  await rm(dir, { recursive: true, force: true });
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
