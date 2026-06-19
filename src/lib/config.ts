// Central configuration, read from the environment.
// All state and computation live on the Optiplex; the NAS is only a read-only source.

function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// List of paths (separated by comma or colon) → cleaned array.
// Allows multiple folders (e.g. several final zones) from today.
function list(name: string, def: string[]): string[] {
  const v = process.env[name];
  if (!v) return def;
  return v
    .split(/[,:]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://winnow:winnow@localhost:5432/winnow",

  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // --- Derivative storage ---------------------------------------------------
  // "disk" driver (MVP) or "s3" (MinIO later). The interface is identical
  // on the code side: we manipulate keys, read/write bytes, sign URLs.
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? "disk") as "disk" | "s3",
    diskPath: process.env.STORAGE_DISK_PATH ?? "/data/derivatives",
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
      region: process.env.S3_REGION ?? "us-east-1",
      bucket: process.env.S3_BUCKET ?? "winnow",
      accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    },
  },

  // Directory where the "RAW copy for Capture One" export drops the originals.
  exportDir: process.env.EXPORT_DIR ?? "/data/exports",

  // --- Ingest / import ------------------------------------------------------
  // All feeders (web upload, SMB drop, device FTP, card offload)
  // converge to the inbox; the import worker verifies (hash), deduplicates, files
  // into the incoming (NAS archive) according to a template, then the indexer takes over.
  import: {
    inboxDir: process.env.INBOX_DIR ?? "/data/inbox",
    // Permanent destination of the imported originals (NAS "incoming" zone).
    incomingDir: process.env.INCOMING_DIR ?? "/nas/incoming",
    // NAS "final" folders (Immich output): indexed for viewing
    // (thumbnails) but never culled/exported. List → multi-folder possible.
    finalsDirs: list("FINALS_DIRS", []),
    concurrency: int("IMPORT_CONCURRENCY", 1),
    // Watches the inbox and enqueues an import when files arrive (SMB/FTP).
    watchInbox: (process.env.WATCH_INBOX ?? "true") === "true",
  },

  // --- Video (derivatives via ffmpeg) --------------------------------------
  // Poster (thumbnail) + playable H.264 mp4 proxy for culling. Hardware
  // acceleration is OPTIONAL: by default "none" (software libx264, works
  // everywhere); set VIDEO_HWACCEL=vaapi once /dev/dri is shared with the container
  // (automatic software fallback if hardware encoding fails).
  video: {
    proxyHeight: int("VIDEO_PROXY_HEIGHT", 720),
    proxyCrf: int("VIDEO_PROXY_CRF", 24),
    hwaccel: (process.env.VIDEO_HWACCEL ?? "none") as "none" | "vaapi",
    vaapiDevice: process.env.VIDEO_VAAPI_DEVICE ?? "/dev/dri/renderD128",
  },

  // --- Bounded concurrency to spare the full HDD of the NAS ----------------
  scanConcurrency: int("SCAN_CONCURRENCY", 1),
  derivativeConcurrency: int("DERIVATIVE_CONCURRENCY", 3),
  exportConcurrency: int("EXPORT_CONCURRENCY", 2),

  // Derivative sizes (cf. §4: grid thumbnail + cull proxy).
  thumbSize: int("THUMB_SIZE", 400),
  proxySize: int("PROXY_SIZE", 2048),
  thumbQuality: int("THUMB_QUALITY", 70),
  proxyQuality: int("PROXY_QUALITY", 80),
};

// Recognized extensions. Culling is always done on lightweight proxies.
export const PHOTO_RAW_EXTS = new Set([
  ".arw", // Sony A7C II
  ".dng", // drone DJI / iPhone ProRAW
  ".cr2",
  ".cr3",
  ".nef",
  ".raf",
  ".rw2",
  ".orf",
]);

// HEIF/HEVC stills: iPhone (.heic/.heif), Sony A7C II / Canon (.hif).
// sharp's prebuilt libvips ships the AVIF decoder but NOT the HEVC one, so these
// are decoded via libheif (heic-convert) before sharp builds the derivatives.
export const HEIC_EXTS = new Set([".heic", ".heif", ".hif"]);

export const PHOTO_DIRECT_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
  ".avif", // AV1-in-HEIF: decoded natively by sharp's libvips
  ".heic", // iPhone
  ".heif",
  ".hif", // Sony A7C II / Canon HEIF
]);

export const VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
]);

export function classifyExt(
  ext: string,
): { mediaType: "photo" | "video"; raw: boolean } | null {
  const e = ext.toLowerCase();
  if (PHOTO_RAW_EXTS.has(e)) return { mediaType: "photo", raw: true };
  if (PHOTO_DIRECT_EXTS.has(e)) return { mediaType: "photo", raw: false };
  if (VIDEO_EXTS.has(e)) return { mediaType: "video", raw: false };
  return null;
}
