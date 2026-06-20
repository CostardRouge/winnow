// EXIF reading + extraction of the embedded preview (cf. §4 - THE critical point).
// We NEVER decode the RAW sensor: we extract the embedded JPEG preview.
import { exiftool, type Tags } from "exiftool-vendored";
import sharp from "sharp";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, HEIC_EXTS, PHOTO_DIRECT_EXTS } from "./config";

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
 *    AVIF decoder but NOT the HEVC one. We prefer the embedded JPEG preview when
 *    the file carries a full-size one (Sony .hif), and otherwise decode the real
 *    pixels with libheif (heic-convert, lazy-loaded + serialized) to a temp JPEG.
 *    libheif applies the container transform (irot/imir) on its own, so for that
 *    decode path we only carry the EXIF orientation when the file has no such
 *    transform (cf. readHeicOrientation) - re-applying it otherwise rotates twice.
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

  // HEIF/HEVC stills. Two-tier strategy, both isolated from the rest of the
  // worker. The embedded preview is its own JPEG (untouched by libheif), so it
  // carries the EXIF orientation as RAW previews do; the libheif decode path,
  // however, gets pixels libheif already oriented from the container transform.
  if (HEIC_EXTS.has(e)) {
    const { exif, containerRotated } = await readHeicOrientation(absPath);
    const dir = await mkdtemp(path.join(tmpdir(), "winnow-"));
    try {
      // 1) A full-size embedded preview is ideal: instant, no pixel decode at
      //    all (Sony .hif and most camera HEIFs ship one).
      const preview = await extractEmbeddedPreview(absPath, dir);
      if (preview && (await longestEdge(preview)) >= config.proxySize) {
        return { jpegPath: preview, cleanupDir: dir, orientation: exif };
      }
      // 2) Otherwise decode the real pixels with libheif. libheif applies the
      //    container transform (irot/imir) itself and ignores EXIF, so we only
      //    re-apply the EXIF orientation when the file carries no container
      //    transform — otherwise the worker would rotate the pixels a 2nd time.
      try {
        const dest = path.join(dir, "decoded.jpg");
        await writeFile(dest, await decodeHeicToJpeg(absPath));
        const orientation = containerRotated ? undefined : exif;
        return { jpegPath: dest, cleanupDir: dir, orientation };
      } catch (decodeErr) {
        // …and if even that fails, a smaller embedded preview still beats no
        // thumbnail at all.
        if (preview)
          return { jpegPath: preview, cleanupDir: dir, orientation: exif };
        throw decodeErr;
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        `HEIF decode failed for ${absPath}: ${(err as Error).message}`,
      );
    }
  }

  // RAW: the embedded preview usually loses the Orientation tag, so we read it
  // on the RAW and let the worker re-apply it.
  const orientation = await readOrientation(absPath);
  const dir = await mkdtemp(path.join(tmpdir(), "winnow-"));
  const preview = await extractEmbeddedPreview(absPath, dir);
  if (preview) return { jpegPath: preview, cleanupDir: dir, orientation };

  await rm(dir, { recursive: true, force: true });
  throw new Error(`No extractable preview from ${absPath}`);
}

// Extract the largest embedded JPEG preview an asset carries (RAW JpgFromRaw,
// otherwise PreviewImage, otherwise ThumbnailImage) into `dir`. Returns the
// written path, or null when the file embeds no usable preview. Near-instant:
// exiftool copies the already-encoded JPEG bytes out — it never demosaics or
// re-decodes the image.
async function extractEmbeddedPreview(
  absPath: string,
  dir: string,
): Promise<string | null> {
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
      if (s.size > 0) return dest;
    } catch {
      /* try the next tag */
    }
  }
  return null;
}

// Longest edge (px) of a JPEG on disk, or 0 when it can't be read. Used to
// decide whether an embedded HEIF preview is big enough to skip the full decode.
async function longestEdge(jpegPath: string): Promise<number> {
  try {
    const { width = 0, height = 0 } = await sharp(jpegPath).metadata();
    return Math.max(width ?? 0, height ?? 0);
  } catch {
    return 0;
  }
}

// Full libheif decode of a HEIF/HEVC still to JPEG bytes. The decoder is:
//   - lazy-loaded: heic-convert pulls in a libheif WASM bundle. Importing it at
//     module top-level would mean any load hiccup takes down extract.ts — and
//     with it derivatives.ts and the whole worker (no photo, RAW OR video
//     thumbnails). Loaded on demand, a failure stays a per-asset error.
//   - serialized: a 33–61 MP HEIF decodes to a full width*height*4 RGBA bitmap
//     and is re-encoded by a pure-JS JPEG encoder, so several at once can
//     exhaust memory and OOM-kill the worker. We cap it to one in-flight decode
//     regardless of DERIVATIVE_CONCURRENCY; the cheap preview path is never gated.
let heicGate: Promise<unknown> = Promise.resolve();
function decodeHeicToJpeg(absPath: string): Promise<Buffer> {
  const run = heicGate.then(async () => {
    const { default: heicConvert } = await import("heic-convert");
    const input = await readFile(absPath);
    // heic-decode sniffs the brand with `String.fromCharCode(...buf.slice(8,12))`
    // (needs an iterable byte view) and libheif wants a Uint8Array: the Node
    // Buffer from readFile satisfies both. The published @types claim
    // ArrayBufferLike, which is wrong for the runtime — hence the cast.
    const jpeg = await heicConvert({
      buffer: input as unknown as ArrayBufferLike,
      format: "JPEG",
    });
    return Buffer.from(jpeg);
  });
  // Keep the gate chained even when a decode throws, without leaking rejections.
  heicGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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

// HEIF orientation can live in two places: the container transformative property
// (`irot`/`imir`) and the EXIF `Orientation` tag. libheif (heic-convert) applies
// the container transform when decoding but ignores EXIF — and per the HEIF spec
// the container transform supersedes EXIF anyway. exiftool surfaces the container
// rotation as the `Rotation` tag, present iff the file carries an `irot` box, so
// we use it to tell whether libheif's output is already display-oriented. When it
// is, the worker must NOT re-apply EXIF (that would rotate the pixels twice).
async function readHeicOrientation(
  absPath: string,
): Promise<{ exif: number | undefined; containerRotated: boolean }> {
  try {
    const tags = await exiftool.read(absPath, ["-n"]);
    const o = (tags as { Orientation?: unknown }).Orientation;
    const r = (tags as { Rotation?: unknown }).Rotation;
    return {
      exif: typeof o === "number" ? o : undefined,
      containerRotated: r != null,
    };
  } catch {
    return { exif: undefined, containerRotated: false };
  }
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}
