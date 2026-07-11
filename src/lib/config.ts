// Central configuration, validated from the environment at startup.
// All state and computation live on the Optiplex; the NAS is only a read-only source.
//
// The whole environment is parsed ONCE, here, through a Zod schema that
// fail-fasts: a missing/garbled/incoherent variable (a typo'd STORAGE_DRIVER,
// a non-numeric concurrency, s3 selected without credentials…) crashes the
// process at boot with a precise message, instead of silently degrading in
// production. Every consumer keeps reading the same `config` object below.

import { z } from "zod";

// --- Env coercion helpers -------------------------------------------------
// Each returns a Zod schema that reads ONE raw env string (or undefined) and
// produces a typed value. Unlike a bare `process.env.X ?? default`, a value
// that is present but invalid is a hard error, not a silent fallback.

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

// Non-empty string, trimmed; falls back to `def` when unset/blank.
function strEnv(def: string) {
  return z
    .string()
    .optional()
    .transform((raw) => {
      const v = raw?.trim();
      return v ? v : def;
    });
}

// Integer within an optional [min, max] range; a non-integer or out-of-range
// value fails instead of silently reverting to `def`.
function intEnv(def: number, range: { min?: number; max?: number } = {}) {
  const { min, max } = range;
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const v = raw?.trim();
      if (!v) return def;
      const n = Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be an integer (got "${raw}")`,
        });
        return z.NEVER;
      }
      if (min !== undefined && n < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be >= ${min} (got ${n})`,
        });
        return z.NEVER;
      }
      if (max !== undefined && n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be <= ${max} (got ${n})`,
        });
        return z.NEVER;
      }
      return n;
    });
}

// Like intEnv but accepts a real number (e.g. a 1.5 s gap); a non-numeric or
// out-of-range value fails instead of silently reverting to `def`.
function numEnv(def: number, range: { min?: number; max?: number } = {}) {
  const { min, max } = range;
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const v = raw?.trim();
      if (!v) return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be a number (got "${raw}")`,
        });
        return z.NEVER;
      }
      if (min !== undefined && n < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be >= ${min} (got ${n})`,
        });
        return z.NEVER;
      }
      if (max !== undefined && n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be <= ${max} (got ${n})`,
        });
        return z.NEVER;
      }
      return n;
    });
}

// Boolean from the usual truthy/falsy spellings; anything else fails (whereas
// the old `=== "true"` quietly turned every typo into `false`).
function boolEnv(def: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const v = raw?.trim().toLowerCase();
      if (!v) return def;
      if (["true", "1", "yes", "on"].includes(v)) return true;
      if (["false", "0", "no", "off"].includes(v)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be a boolean (true/false), got "${raw}"`,
      });
      return z.NEVER;
    });
}

// Paths separated by comma or colon → cleaned array. Allows multiple folders
// (e.g. several final zones). Falls back to `def` when unset/blank/empty.
function listEnv(def: string[]) {
  return z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined) return def;
      const items = raw
        .split(/[,:]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return items.length ? items : def;
    });
}

// One enum value (blank → default); a value outside the set is reported with
// the list of accepted values.
function enumEnv<const T extends readonly [string, ...string[]]>(
  values: T,
  def: T[number],
) {
  return z.preprocess(blankToUndefined, z.enum(values).default(def));
}

// --- The schema: one entry per recognized environment variable ------------

const EnvSchema = z
  .object({
    DATABASE_URL: strEnv("postgres://winnow:winnow@localhost:5432/winnow"),
    REDIS_URL: strEnv("redis://localhost:6379"),

    // --- Derivative storage -----------------------------------------------
    // "disk" driver (MVP) or "s3" (MinIO later). The interface is identical
    // on the code side: we manipulate keys, read/write bytes, sign URLs.
    STORAGE_DRIVER: enumEnv(["disk", "s3"], "disk"),
    STORAGE_DISK_PATH: strEnv("/data/derivatives"),
    S3_ENDPOINT: strEnv("http://localhost:9000"),
    S3_REGION: strEnv("us-east-1"),
    S3_BUCKET: strEnv("winnow"),
    S3_ACCESS_KEY: strEnv("minioadmin"),
    S3_SECRET_KEY: strEnv("minioadmin"),
    S3_FORCE_PATH_STYLE: boolEnv(true),

    // Directory where the "RAW copy for Capture One" export drops the originals.
    EXPORT_DIR: strEnv("/data/exports"),

    // --- Folder picker (Volumes "Add folder") -----------------------------
    // Base directories the server-side folder picker is allowed to browse. The
    // configured volume dirs (incoming/finals/export) are always added on top,
    // so this is really "where else can I browse" — defaults to the NAS mount.
    // Containment to these roots is what stops the picker from ever exposing
    // the OS (/etc, /usr, …) or letting "/" be registered by hand.
    BROWSE_ROOTS: listEnv(["/nas"]),

    // --- Ingest / import --------------------------------------------------
    // All feeders (web upload, SMB drop, device FTP, card offload) converge to
    // the inbox; the import worker verifies (hash), deduplicates, files into
    // the incoming (NAS archive) per a template, then the indexer takes over.
    INBOX_DIR: strEnv("/data/inbox"),
    // Permanent destination of the imported originals (NAS "incoming" zone).
    INCOMING_DIR: strEnv("/nas/incoming"),
    // NAS "final" folders (Immich output): indexed for viewing (thumbnails)
    // but never culled/exported. List → multi-folder possible.
    FINALS_DIRS: listEnv([]),
    IMPORT_CONCURRENCY: intEnv(1, { min: 1 }),
    // Watches the inbox and enqueues an import when files arrive (SMB/FTP).
    WATCH_INBOX: boolEnv(true),

    // --- Video (derivatives via ffmpeg) -----------------------------------
    // Poster (thumbnail) + playable H.264 mp4 proxy for culling. Hardware
    // acceleration is OPTIONAL: by default "none" (software libx264, works
    // everywhere); set VIDEO_HWACCEL=vaapi once /dev/dri is shared with the
    // container (automatic software fallback if hardware encoding fails).
    VIDEO_PROXY_HEIGHT: intEnv(720, { min: 1 }),
    VIDEO_PROXY_CRF: intEnv(24, { min: 0, max: 63 }),
    VIDEO_HWACCEL: enumEnv(["none", "vaapi"], "none"),
    VIDEO_VAAPI_DEVICE: strEnv("/dev/dri/renderD128"),

    // --- Bounded concurrency to spare the full HDD of the NAS -------------
    SCAN_CONCURRENCY: intEnv(1, { min: 1 }),
    DERIVATIVE_CONCURRENCY: intEnv(3, { min: 1 }),
    EXPORT_CONCURRENCY: intEnv(2, { min: 1 }),
    PURGE_CONCURRENCY: intEnv(1, { min: 1 }),

    // libvips threads PER sharp operation. Defaults to the CPU count, which —
    // multiplied by DERIVATIVE_CONCURRENCY jobs each decoding a large RAW
    // preview — spins up dozens of native threads, and under glibc each carries
    // its own malloc arena that fragments and pins RSS. We already bound
    // parallelism at the job level, so 1 thread per op keeps memory flat without
    // hurting throughput. Raise it only if derivative latency matters more than RAM.
    SHARP_CONCURRENCY: intEnv(1, { min: 1 }),

    // --- Purge (reclaim space) -------------------------------------------
    // The end of the "winnowing": soft-delete is the recycle bin (recoverable),
    // purge physically removes the trashed originals + their derivatives to free
    // the NAS. Irreversible → always gated by a UI confirmation. Set
    // PURGE_ENABLED=false to disable the action entirely (the route returns 403).
    // Note: only paths mounted read/write can actually be freed; rejects living
    // on a read-only mount surface a per-file error and stay in the trash.
    PURGE_ENABLED: boolEnv(true),

    // --- Burst / bracket stacks (culling grid) ---------------------------
    // Group N distinct frames shot in one quick run (rafale / AEB bracket) into
    // one collapsible "pile" the grid can cull as a unit (cf. lib/bursts.ts).
    // A new pile starts when the gap to the previous frame exceeds
    // BURST_GAP_SECONDS or the device changes; a run of >= BURST_MIN_FRAMES
    // becomes a stack (shorter runs stay standalone).
    BURST_GAP_SECONDS: numEnv(1.5, { min: 0 }),
    BURST_MIN_FRAMES: intEnv(3, { min: 2 }),

    // Derivative sizes (cf. §4: grid thumbnail + cull proxy).
    THUMB_SIZE: intEnv(400, { min: 1 }),
    PROXY_SIZE: intEnv(2048, { min: 1 }),
    THUMB_QUALITY: intEnv(70, { min: 1, max: 100 }),
    PROXY_QUALITY: intEnv(80, { min: 1, max: 100 }),

    // --- Reverse geocoding (GPS → place names) ---------------------------
    // Resolves the place names (country / région / département / city, plus a
    // tourist POI on demand) behind the coordinates we already index. Off its own
    // BullMQ queue + worker (cf. lib/geocode.ts). The runtime knobs — precision
    // (cell size) and hourly rate — live in app_settings so they're tunable
    // without a redeploy; only the provider endpoint/identity is env-level.
    //
    // Default provider is the OpenStreetMap Nominatim PUBLIC instance: free and
    // rich, but ~1 req/s and no bulk. Point GEOCODE_BASE_URL at a self-hosted
    // Nominatim or a compatible service (LocationIQ, Photon) for heavier use — no
    // code change. GEOCODE_USER_AGENT is REQUIRED by Nominatim's usage policy.
    GEOCODE_ENABLED: boolEnv(true),
    GEOCODE_PROVIDER: enumEnv(["nominatim"], "nominatim"),
    GEOCODE_BASE_URL: strEnv("https://nominatim.openstreetmap.org"),
    GEOCODE_USER_AGENT: strEnv("winnow/0.1 (self-hosted media manager)"),
    // Optional Nominatim etiquette: an email appended to each request so the
    // operator can reach you before rate-limiting. Blank → omitted.
    GEOCODE_EMAIL: strEnv(""),
    // accept-language for the returned names. Blank → the provider's default
    // (local/native names, e.g. "France", "Bretagne"). Set "en"/"fr"/… to force one.
    GEOCODE_LANGUAGE: strEnv(""),
    // Serialized by default (the public Nominatim is single-flight anyway). The
    // per-hour rate (app_settings) is what actually paces it.
    GEOCODE_CONCURRENCY: intEnv(1, { min: 1 }),
    GEOCODE_TIMEOUT_MS: intEnv(15000, { min: 1000 }),

    // --- ML analysis (faces + OCR via a self-hosted container) -----------
    // Sends each media's existing derivative (photo proxy / video poster) to an
    // immich-machine-learning container over HTTP and stores the detected faces
    // + the text read in the image (cf. lib/ml.ts). Off its own BullMQ queue +
    // worker; the hourly rate lives in app_settings (mlPerHour) so the 80k-media
    // backfill can be paced live from the Pipeline page without a redeploy.
    //
    // Disabled by default: there is no public endpoint to fall back to — point
    // ML_BASE_URL at the container you already run (Immich's ML sidecar) and
    // flip ML_ENABLED=true. The API is Immich-internal and unversioned: pin the
    // container image tag and re-check after upgrading it.
    ML_ENABLED: boolEnv(false),
    ML_PROVIDER: enumEnv(["immich"], "immich"),
    ML_BASE_URL: strEnv("http://immich-machine-learning:3003"),
    // Face detection/recognition (InsightFace). buffalo_l is Immich's default;
    // the container downloads the model on first use.
    ML_FACES_ENABLED: boolEnv(true),
    ML_FACE_MODEL: strEnv("buffalo_l"),
    ML_FACE_MIN_SCORE: numEnv(0.7, { min: 0, max: 1 }),
    // OCR (text in images) needs immich-machine-learning >= v2.2.0 (RapidOCR /
    // PP-OCRv5). Set false against an older container so the whole job doesn't fail.
    ML_OCR_ENABLED: boolEnv(true),
    ML_OCR_MODEL: strEnv("PP-OCRv5_mobile"),
    ML_OCR_MIN_SCORE: numEnv(0.8, { min: 0, max: 1 }),
    // Serialized by default: the container queues requests without backpressure,
    // so a small in-flight count is what protects a CPU-only box. The per-hour
    // rate (app_settings) is what actually paces the backfill.
    ML_CONCURRENCY: intEnv(1, { min: 1 }),
    // Generous: the FIRST request after container start/idle pays the model
    // download+load (can take minutes on first ever use).
    ML_TIMEOUT_MS: intEnv(120000, { min: 1000 }),

    // --- HEIF/HEVC decode (libheif) --------------------------------------
    // A malformed HEIF can make libheif throw ASYNCHRONOUSLY from inside its
    // WASM (seen in the wild: "RangeError: offset is out of bounds" on a timer
    // callback) — the throw escapes the await, so heic-convert's promise never
    // settles. Decodes are serialized through a single gate, so one dangling
    // decode would jam EVERY later HEIF forever. We bound each decode: past this
    // many ms it is abandoned (the asset falls back to its embedded preview, or
    // is marked 'error') and the gate is freed. 0 disables the time cap (the
    // async-throw guard still frees the gate). Generous by default so a slow
    // 60 MP decode on a busy box is never cut short.
    HEIC_DECODE_TIMEOUT_MS: intEnv(120000, { min: 0 }),
  })
  .superRefine((_env, ctx) => {
    // Coherence: selecting the s3 driver but leaving the dev defaults in place
    // (localhost endpoint, minioadmin credentials) is almost always a misconfig
    // in production — require them to be set explicitly. We look at the raw env
    // because the parsed values always carry their dev fallback.
    if (blankToUndefined(process.env.STORAGE_DRIVER) === "s3") {
      for (const key of [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
      ] as const) {
        if (!process.env[key]?.trim()) {
          ctx.addIssue({
            path: [key],
            code: z.ZodIssueCode.custom,
            message: "must be set explicitly when STORAGE_DRIVER=s3",
          });
        }
      }
    }
  });

function loadConfig() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const where = i.path.join(".") || "(env)";
      return `  - ${where}: ${i.message}`;
    });
    // Fail fast: a broken config must never boot into a silent, half-working
    // state. The aggregated message lists every offending variable at once.
    throw new Error(
      `Invalid Winnow configuration — fix these environment variables:\n${lines.join("\n")}`,
    );
  }
  const e = parsed.data;

  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,

    storage: {
      driver: e.STORAGE_DRIVER,
      diskPath: e.STORAGE_DISK_PATH,
      s3: {
        endpoint: e.S3_ENDPOINT,
        region: e.S3_REGION,
        bucket: e.S3_BUCKET,
        accessKeyId: e.S3_ACCESS_KEY,
        secretAccessKey: e.S3_SECRET_KEY,
        forcePathStyle: e.S3_FORCE_PATH_STYLE,
      },
    },

    exportDir: e.EXPORT_DIR,

    browse: {
      roots: e.BROWSE_ROOTS,
    },

    import: {
      inboxDir: e.INBOX_DIR,
      incomingDir: e.INCOMING_DIR,
      finalsDirs: e.FINALS_DIRS,
      concurrency: e.IMPORT_CONCURRENCY,
      watchInbox: e.WATCH_INBOX,
    },

    video: {
      proxyHeight: e.VIDEO_PROXY_HEIGHT,
      proxyCrf: e.VIDEO_PROXY_CRF,
      hwaccel: e.VIDEO_HWACCEL,
      vaapiDevice: e.VIDEO_VAAPI_DEVICE,
    },

    scanConcurrency: e.SCAN_CONCURRENCY,
    derivativeConcurrency: e.DERIVATIVE_CONCURRENCY,
    exportConcurrency: e.EXPORT_CONCURRENCY,
    purgeConcurrency: e.PURGE_CONCURRENCY,
    sharpConcurrency: e.SHARP_CONCURRENCY,

    // Reclaim-space (purge) capability. `enabled=false` makes /api/purge 403.
    purge: {
      enabled: e.PURGE_ENABLED,
    },

    // Burst / bracket stacking thresholds (cf. lib/bursts.ts).
    burst: {
      gapSeconds: e.BURST_GAP_SECONDS,
      minFrames: e.BURST_MIN_FRAMES,
    },

    thumbSize: e.THUMB_SIZE,
    proxySize: e.PROXY_SIZE,
    thumbQuality: e.THUMB_QUALITY,
    proxyQuality: e.PROXY_QUALITY,

    heicDecodeTimeoutMs: e.HEIC_DECODE_TIMEOUT_MS,

    geocode: {
      enabled: e.GEOCODE_ENABLED,
      provider: e.GEOCODE_PROVIDER,
      baseUrl: e.GEOCODE_BASE_URL,
      userAgent: e.GEOCODE_USER_AGENT,
      email: e.GEOCODE_EMAIL,
      language: e.GEOCODE_LANGUAGE,
      concurrency: e.GEOCODE_CONCURRENCY,
      timeoutMs: e.GEOCODE_TIMEOUT_MS,
    },

    ml: {
      enabled: e.ML_ENABLED,
      provider: e.ML_PROVIDER,
      baseUrl: e.ML_BASE_URL,
      faces: {
        enabled: e.ML_FACES_ENABLED,
        model: e.ML_FACE_MODEL,
        minScore: e.ML_FACE_MIN_SCORE,
      },
      ocr: {
        enabled: e.ML_OCR_ENABLED,
        model: e.ML_OCR_MODEL,
        minScore: e.ML_OCR_MIN_SCORE,
      },
      concurrency: e.ML_CONCURRENCY,
      timeoutMs: e.ML_TIMEOUT_MS,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();

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

// Directory/file names that are never our media and must never be walked into,
// indexed, or shown in the folder picker. Beyond the usual hidden entries
// (.DS_Store, dot-folders), a NAS litters the tree with sidecar/junk folders
// sitting right next to the real files — most notably Synology's per-file
// thumbnail trees (`@eaDir/<file>/SYNOFILE_THUMB_*.jpg`) and its recycle bin
// (`#recycle`). Skipping the *folder* prunes its whole subtree in one go, so the
// thumbnails inside an `@eaDir` are never even seen (cf. the walk in indexer.ts).
export const IGNORED_ENTRY_NAMES = new Set([
  "@eaDir", // Synology — per-file thumbnail/metadata folders
  "#recycle", // Synology — recycle bin
]);

// True for any directory entry the walk must skip (and the picker must hide):
// hidden dotfiles plus the NAS junk folders above. Centralized so the indexer,
// the import feeder and the folder picker all prune the same noise identically.
export function isIgnoredEntry(name: string): boolean {
  return name.startsWith(".") || IGNORED_ENTRY_NAMES.has(name);
}
