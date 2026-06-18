// Configuration centrale, lue depuis l'environnement.
// Tout l'état et le calcul vivent sur l'Optiplex ; le NAS n'est que source RO.

function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://winnow:winnow@localhost:5432/winnow",

  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // --- Stockage des dérivés -------------------------------------------------
  // Pilote "disk" (MVP) ou "s3" (MinIO plus tard). L'interface est identique
  // côté code : on manipule des clés, on lit/écrit des octets, on signe des URL.
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

  // Répertoire où l'export "copie RAW pour Capture One" dépose les originaux.
  exportDir: process.env.EXPORT_DIR ?? "/data/exports",

  // --- Concurrence bornée pour ménager le HDD plein du NAS ------------------
  scanConcurrency: int("SCAN_CONCURRENCY", 1),
  derivativeConcurrency: int("DERIVATIVE_CONCURRENCY", 3),
  exportConcurrency: int("EXPORT_CONCURRENCY", 2),

  // Tailles des dérivés (cf. §4 : thumbnail grille + proxie de tri).
  thumbSize: int("THUMB_SIZE", 400),
  proxySize: int("PROXY_SIZE", 2048),
  thumbQuality: int("THUMB_QUALITY", 70),
  proxyQuality: int("PROXY_QUALITY", 80),
};

// Extensions reconnues. Le tri se fait toujours sur des proxies légers.
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

export const PHOTO_DIRECT_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
  ".heic", // iPhone
  ".heif",
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
