// EXIF reading + extraction of the embedded preview (cf. §4 - THE critical point).
// We NEVER decode the RAW sensor: we extract the embedded JPEG preview.
import { exiftool, type Tags } from "exiftool-vendored";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, HEIC_EXTS, PHOTO_DIRECT_EXTS } from "./config";
import { readHeicOrientation, readOrientation } from "./orientation";

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
  // iPhone Live Photo link: Apple's Content Identifier (a UUID written on BOTH
  // the still and its companion .mov). Null for everything that isn't a Live
  // Photo member. Used by lib/pairing.ts to tie the pair at scan time.
  content_id: string | null;
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

// Coerce an EXIF tag value into a clean display string, or null. exiftool-vendored
// normally hands back strings/numbers, but some tags arrive as a plain object —
// notably certain Sony lens fields on video files, which carry no usable
// LensModel. A bare `.toString()` on such a value yields the literal
// "[object Object]", and that placeholder was being stored as the lens and then
// surfaced as a junk chip in the filter sidebar. We accept strings and finite
// numbers, trust a *meaningful* custom toString() (e.g. an ExifDateTime), and
// otherwise drop the value rather than persist a placeholder.
function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return null;
  // Object/array: String() uses any overridden toString (ExifDateTime, arrays…)
  // but falls back to "[object Object]" for plain objects — never store that.
  const s = String(v).trim();
  return !s || s.startsWith("[object ") ? null : s;
}

export async function readMetadata(absPath: string): Promise<Metadata> {
  const t: Tags = await exiftool.read(absPath);
  const make = str(t.Make) ?? "";
  const model = str(t.Model) ?? "";
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
    // Try each lens tag in turn, coercing every candidate to a clean string so an
    // empty/object-valued LensModel falls through to LensID / Lens instead of
    // winning the `??` and poisoning the value.
    lens:
      str(t.LensModel) ?? str((t as any).LensID) ?? str((t as any).Lens),
    iso: num(t.ISO),
    shutter: str(t.ShutterSpeed) ?? str(t.ExposureTime),
    aperture: num(t.FNumber ?? (t as any).Aperture),
    focal_length: num(t.FocalLength),
    gps,
    width: num(t.ImageWidth ?? (t as any).ExifImageWidth),
    height: num(t.ImageHeight ?? (t as any).ExifImageHeight),
    duration_s: num((t as any).Duration ?? (t as any).MediaDuration),
    // Apple writes the Live-Photo UUID as `ContentIdentifier` on the still
    // (MakerNotes) and the .mov (QuickTime); `MediaGroupUUID` is the legacy
    // spelling seen on some stills. Either side of the pair carries the same
    // value, which is exactly what lets lib/pairing.ts match them.
    content_id:
      str((t as any).ContentIdentifier) ?? str((t as any).MediaGroupUUID),
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
        await decodeHeicToJpegFile(absPath, dest);
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

// Resolved relative to this module so it works identically under tsx (the dev
// server and the worker both run via tsx) and from wherever the worker is
// launched. We deliberately avoid `new URL("…", import.meta.url)` here: webpack
// special-cases that exact form as a static asset reference and the Next build
// (which transitively bundles this module) crashes collecting it. Splitting the
// path keeps that pattern away from the bundler while staying correct at the only
// place this constant is ever *used* — the worker, run via tsx.
const HEIC_DECODER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "heicDecode.ts",
);

// Full libheif decode of a HEIF/HEVC still to a JPEG file on disk. The decoder is:
//   - out-of-process: heic-convert pulls in a libheif WASM bundle whose linear
//     heap only ever GROWS (never returned to the OS), and libheif-js leaks
//     decoder handles across conversions — so decoding it in the long-lived
//     worker walks RSS up into multiple GB and never releases it. We run each
//     decode in a throwaway child (src/scripts/heicDecode.ts) whose whole
//     address space — WASM heap included — the OS reclaims the moment it exits.
//     This also keeps any load hiccup or hard crash inside libheif a per-asset
//     error instead of taking down extract.ts and the whole worker.
//   - serialized: a 33–61 MP HEIF decodes to a full width*height*4 RGBA bitmap
//     re-encoded by a pure-JS JPEG encoder, so several at once can exhaust
//     memory even across processes. We cap it to one in-flight decode regardless
//     of DERIVATIVE_CONCURRENCY; the cheap preview path is never gated.
//   - file-out: the child writes the JPEG directly to `destPath`, so the decoded
//     bytes never transit the worker's heap.
let heicGate: Promise<unknown> = Promise.resolve();
function decodeHeicToJpegFile(absPath: string, destPath: string): Promise<void> {
  const run = heicGate.then(() => decodeHeicChild(absPath, destPath));
  // Keep the gate chained even when a decode throws, without leaking rejections.
  // decodeHeicChild ALWAYS settles (the child's `close` event always fires, and a
  // hung child is killed by the timeout below), so this chain can never stall —
  // one bad file can't jam the gate for every later HEIF.
  heicGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// One decode, run strictly one-at-a-time (serialized by heicGate) in a throwaway
// child process. Running it out-of-process is what subsumes libheif's two real
// failure modes that previously needed in-process guard rails:
//   1. a normal heic-convert rejection, and
//   2. an ASYNCHRONOUS throw from inside the WASM ("RangeError: offset is out of
//      bounds" on a malformed HEIF) that escapes the await — in-process this left
//      the decode dangling and jammed the serialized gate for every later HEIF.
// Both now just fail (or crash) the child, whose `close` event ALWAYS fires, so
// the gate is freed and the asset falls back to its embedded preview. The only
// remaining hang mode is a child that neither throws nor exits (libheif spinning):
// HEIC_DECODE_TIMEOUT_MS backstops it — we SIGKILL the child and the OS reclaims
// its whole wedged address space, WASM heap included. 0 disables the time cap.
function decodeHeicChild(absPath: string, destPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `node --import tsx` registers the tsx loader in the child (ESM loaders
    // aren't inherited across spawns); tsx is a runtime dependency, present both
    // in dev and in the production image.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", HEIC_DECODER, absPath, destPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      action();
    };
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() =>
        code === 0
          ? resolve()
          : reject(
              new Error(`heic decode failed (code ${code}): ${stderr.trim()}`),
            ),
      ),
    );
    const timeoutMs = config.heicDecodeTimeoutMs;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(new Error(`HEIF decode timed out after ${timeoutMs} ms`)),
        );
      }, timeoutMs);
      timer.unref();
    }
  });
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end();
}
