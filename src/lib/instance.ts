// Read-only description of how THIS process is configured — the data behind
// Settings › Instance.
//
// Sixty-eight environment variables decide whether ML runs and against which
// models, whether the Immich push is configured, which geocoder is called and
// where exports land. Until this existed, the app surfaced two derived booleans
// (`stats.mlEnabled`, `stats.clipEnabled`) and the pgvector row on the Database
// page, so "is Immich push configured?" could not be answered from the UI at
// all — you read the compose file, or you guessed. This module answers it.
//
// ## Why every row carries its SOURCE
//
// The effective value alone is not the interesting part: a default and a value
// deliberately set to the same thing look identical, and the failure this page
// exists to catch is the silent one. `docker-compose-optiplex.yml`'s
// `x-winnow-env` anchor is missing a documented set of variables, so those knobs
// simply cannot be tuned on the Optiplex — and nothing anywhere says so, because
// the defaults keep production running (cf. docs/memory/configuration.md).
// `fromEnv` is what makes that visible: a variable you believe you set, showing
// "default", is the whole bug on one line.
//
// ## What is NOT here
//
// Health, queues and counters — those belong to the pipeline pages and to the
// Overview pane that does not exist yet (A3 in docs/SETTINGS-UI.md). This is the
// operator's tier and nothing else: 99 knobs live in four tiers, and the other
// three (app_settings, feature flags, device preferences) have their own homes.
import { config } from "./config";

export type InstanceField = {
  /** The environment variable this row is the effective value of. */
  env: string;
  label: string;
  /** Rendered for display, already redacted where `secret` is set. */
  value: string;
  /** Set in this process's environment, rather than the schema's default. */
  fromEnv: boolean;
  /** A credential: `value` is a present/absent word, never the bytes. */
  secret?: boolean;
  /** One line on what the value does, where that is not obvious. */
  note?: string;
};

export type InstanceGroup = {
  id: string;
  label: string;
  blurb: string;
  /**
   * Whether the subsystem is switched on. A group that is OFF still renders
   * every field: "Immich push is off" is an answer, and an empty section is
   * not.
   */
  on?: boolean;
  fields: InstanceField[];
};

export type InstanceReport = {
  runtime: {
    node: string;
    platform: string;
    uptimeSeconds: number;
    startedAt: string;
  };
  groups: InstanceGroup[];
  counts: { total: number; fromEnv: number; defaults: number };
};

// Mirrors `blankToUndefined` in config.ts: a variable that is present but blank
// is the same as unset and falls through to the schema default, so testing for
// presence alone would report a value this process is not using.
function isSet(name: string): boolean {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim() !== "";
}

function render(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length ? value.join(" · ") : "none";
  if (value === "" || value == null) return "—";
  return String(value);
}

// Strips the credentials out of a connection string while keeping the part that
// is worth reading (host, port, database). Regex rather than `new URL`: a DSN
// that fails to parse must still be shown redacted, never raw.
function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//•••@");
}

function field(
  env: string,
  label: string,
  value: unknown,
  note?: string,
): InstanceField {
  return { env, label, value: render(value), fromEnv: isSet(env), note };
}

function credential(
  env: string,
  label: string,
  value: string,
  note?: string,
): InstanceField {
  return {
    env,
    label,
    value: value.trim() ? "set" : "not set",
    fromEnv: isSet(env),
    secret: true,
    note,
  };
}

export function describeInstance(): InstanceReport {
  const c = config;
  const groups: InstanceGroup[] = [];

  groups.push({
    id: "stores",
    label: "Data stores",
    blurb:
      "Postgres holds the only state that is not regenerable; Redis carries the queues. Credentials are stripped from both URLs.",
    fields: [
      field("DATABASE_URL", "Postgres", redactUrl(c.databaseUrl)),
      field(
        "DB_POOL_MAX",
        "Pool size, per process",
        c.dbPoolMax,
        "The app and the worker each open their own pool, so Postgres sees up to twice this.",
      ),
      field("REDIS_URL", "Redis", redactUrl(c.redisUrl)),
      field(
        "BACKUPS_DIR",
        "Scheduled dumps",
        c.backupsDir,
        "Where the backup sidecar's dumps are read from — listed on the Database page when the folder is mounted.",
      ),
    ],
  });

  const s3 = c.storage.s3;
  groups.push({
    id: "storage",
    label: "Derivative storage",
    blurb:
      "Thumbnails and proxies sit behind an S3-shaped driver, so the disk and MinIO are one variable apart. Originals are never stored here — they stay on the NAS.",
    fields:
      c.storage.driver === "s3"
        ? [
            field("STORAGE_DRIVER", "Driver", c.storage.driver),
            field("S3_ENDPOINT", "Endpoint", s3.endpoint),
            field("S3_REGION", "Region", s3.region),
            field("S3_BUCKET", "Bucket", s3.bucket),
            field("S3_FORCE_PATH_STYLE", "Path-style URLs", s3.forcePathStyle),
            credential("S3_ACCESS_KEY", "Access key", s3.accessKeyId),
            credential("S3_SECRET_KEY", "Secret key", s3.secretAccessKey),
          ]
        : [
            field("STORAGE_DRIVER", "Driver", c.storage.driver),
            field("STORAGE_DISK_PATH", "Derivatives path", c.storage.diskPath),
          ],
  });

  groups.push({
    id: "paths",
    label: "Volumes and paths",
    blurb:
      "Where media comes from and goes. These seed the Volumes registry's defaults; a folder added there is stored in the database, not here.",
    fields: [
      field("INCOMING_DIR", "Incoming (NAS archive)", c.import.incomingDir),
      field("FINALS_DIRS", "Finals", c.import.finalsDirs),
      field("EXPORT_DIR", "Exports", c.exportDir),
      field(
        "INBOX_DIR",
        "Inbox",
        c.import.inboxDir,
        "Every feeder — web upload, SMB drop, FTP, card offload — converges here before the import worker files it.",
      ),
      field(
        "BROWSE_ROOTS",
        "Folder picker roots",
        c.browse.roots,
        "The only places the “Add folder” picker may browse. Containment here is what stops the OS tree being registered.",
      ),
    ],
  });

  groups.push({
    id: "ingest",
    label: "Ingest",
    blurb: "How media enters, and how much of it at once.",
    fields: [
      field("WATCH_INBOX", "Watch the inbox", c.import.watchInbox),
      field("IMPORT_CONCURRENCY", "Import jobs in parallel", c.import.concurrency),
    ],
  });

  groups.push({
    id: "derivatives",
    label: "Derivatives",
    blurb:
      "The sizes culling actually happens on. Changing them does not rebuild what already exists — the existing derivatives keep their old dimensions until they are regenerated.",
    fields: [
      field("THUMB_SIZE", "Thumbnail size", `${c.thumbSize} px`),
      field("PROXY_SIZE", "Proxy size", `${c.proxySize} px`),
      field("THUMB_QUALITY", "Thumbnail quality", c.thumbQuality),
      field("PROXY_QUALITY", "Proxy quality", c.proxyQuality),
      field(
        "HEIC_DECODE_TIMEOUT_MS",
        "HEIF decode timeout",
        `${c.heicDecodeTimeoutMs.toLocaleString("en-GB")} ms`,
        "HEIF is decoded out of process; this bounds a decode that hangs.",
      ),
    ],
  });

  groups.push({
    id: "video",
    label: "Video proxies",
    blurb: "How video proxies are transcoded.",
    fields: [
      field("VIDEO_PROXY_HEIGHT", "Proxy height", `${c.video.proxyHeight} px`),
      field("VIDEO_PROXY_CRF", "CRF", c.video.proxyCrf),
      field("VIDEO_HWACCEL", "Hardware acceleration", c.video.hwaccel),
      field("VIDEO_VAAPI_DEVICE", "VAAPI device", c.video.vaapiDevice),
    ],
  });

  groups.push({
    id: "concurrency",
    label: "Worker concurrency",
    blurb:
      "How many jobs of each kind run at once. These shape process startup and need a restart — the hourly RATES that pace the same queues are live, on Settings › Pipeline.",
    fields: [
      field("SCAN_CONCURRENCY", "Indexing", c.scanConcurrency),
      field("DERIVATIVE_CONCURRENCY", "Derivatives", c.derivativeConcurrency),
      field("EXPORT_CONCURRENCY", "Exports", c.exportConcurrency),
      field("PURGE_CONCURRENCY", "Purge", c.purgeConcurrency),
      field("GEOCODE_CONCURRENCY", "Geocoding", c.geocode.concurrency),
      field("ML_CONCURRENCY", "Machine learning", c.ml.concurrency),
      field(
        "SHARP_CONCURRENCY",
        "libvips threads",
        c.sharpConcurrency,
        "Threads inside sharp, multiplied by the derivative concurrency above.",
      ),
    ],
  });

  groups.push({
    id: "bursts",
    label: "Burst stacking",
    blurb:
      "What counts as a burst or a bracket. These change what you see rather than how the box runs, and are re-derivable — which is why they are a candidate to move into the live settings (E25 in docs/SETTINGS-UI.md).",
    fields: [
      field("BURST_GAP_SECONDS", "Maximum gap", `${c.burst.gapSeconds} s`),
      field("BURST_MIN_FRAMES", "Minimum frames", c.burst.minFrames),
      field("BURST_BRACKET_EV_EPSILON", "Bracket EV tolerance", c.burst.bracketEvEpsilon),
    ],
  });

  groups.push({
    id: "geocode",
    label: "Reverse geocoding",
    on: c.geocode.enabled,
    blurb:
      "GPS coordinates to place names. The call rate and the cell size are live, on Settings › Pipeline; everything here needs a restart.",
    fields: [
      field("GEOCODE_ENABLED", "Enabled", c.geocode.enabled),
      field("GEOCODE_PROVIDER", "Provider", c.geocode.provider),
      field("GEOCODE_BASE_URL", "Endpoint", c.geocode.baseUrl),
      field("GEOCODE_LANGUAGE", "Language", c.geocode.language),
      field(
        "GEOCODE_USER_AGENT",
        "User agent",
        c.geocode.userAgent,
        "Sent with every call. Nominatim's usage policy requires it to identify the caller.",
      ),
      field(
        "GEOCODE_EMAIL",
        "Contact address",
        c.geocode.email,
        "Shown rather than redacted because it is disclosed by design: it is sent to the geocoder with every request.",
      ),
      field("GEOCODE_TIMEOUT_MS", "Timeout", `${c.geocode.timeoutMs.toLocaleString("en-GB")} ms`),
    ],
  });

  groups.push({
    id: "ml",
    label: "Machine learning",
    on: c.ml.enabled,
    blurb:
      "Faces, text and the search embedding, all from one remote call — Winnow embeds no model. A model name changing is what invalidates an index, so these are worth checking after an upgrade of the ML container.",
    fields: [
      field("ML_ENABLED", "Enabled", c.ml.enabled),
      field("ML_PROVIDER", "Provider", c.ml.provider),
      field("ML_BASE_URL", "Endpoint", c.ml.baseUrl),
      field("ML_FACES_ENABLED", "Face detection", c.ml.faces.enabled),
      field("ML_FACE_MODEL", "Face model", c.ml.faces.model),
      field("ML_FACE_MIN_SCORE", "Face minimum score", c.ml.faces.minScore),
      field(
        "ML_PERSON_MIN_SIMILARITY",
        "Person match threshold",
        c.ml.person.minSimilarity,
        "How readily two faces are treated as the same person.",
      ),
      field(
        "ML_PERSON_MIN_FACES",
        "Person minimum faces",
        c.ml.person.minFaces,
        "Below this, a cluster is not offered on the People page at all.",
      ),
      field("ML_OCR_ENABLED", "Text recognition", c.ml.ocr.enabled),
      field("ML_OCR_MODEL", "OCR model", c.ml.ocr.model),
      field("ML_OCR_MIN_SCORE", "OCR minimum score", c.ml.ocr.minScore),
      field("ML_CLIP_ENABLED", "Semantic search", c.ml.clip.enabled),
      field(
        "ML_CLIP_MODEL",
        "CLIP model",
        c.ml.clip.model,
        "Changing it makes every stored embedding incomparable — the index has to be rebuilt.",
      ),
      field("ML_TIMEOUT_MS", "Timeout", `${c.ml.timeoutMs.toLocaleString("en-GB")} ms`),
    ],
  });

  groups.push({
    id: "immich",
    label: "Immich push",
    on: c.immich.enabled,
    blurb:
      "Pushing culled keepers to the Immich library that serves the phone. Copies through its public REST API — Winnow never writes into Immich's storage or its database.",
    fields: [
      field("IMMICH_ENABLED", "Enabled", c.immich.enabled),
      field("IMMICH_BASE_URL", "Server", c.immich.baseUrl),
      credential(
        "IMMICH_API_KEY",
        "API key",
        c.immich.apiKey,
        "Required when the push is enabled; the configuration refuses to boot without it.",
      ),
      field("IMMICH_ALBUM_MODE", "Album", c.immich.albumMode),
      field("IMMICH_ALBUM_NAME", "Fixed album name", c.immich.albumName),
      field(
        "IMMICH_PRECHECK",
        "Checksum pre-check",
        c.immich.precheck,
        "Asks Immich what it already has before uploading, so a re-pushed export sends no bytes.",
      ),
      field("IMMICH_TIMEOUT_MS", "Timeout", `${c.immich.timeoutMs.toLocaleString("en-GB")} ms`),
    ],
  });

  groups.push({
    id: "access",
    label: "Access and capabilities",
    blurb:
      "Who may call this instance from another origin, and whether the most destructive verb is available at all.",
    fields: [
      field(
        "CORS_ALLOWED_ORIGINS",
        "Trusted client origins",
        c.cors.allowedOrigins,
        "Exact origins only, allowed to call the API with the session cookie. Empty means no cross-origin access.",
      ),
      field(
        "PURGE_ENABLED",
        "Purge available",
        c.purge.enabled,
        "Off makes the purge route answer 403 — physical deletion becomes unreachable.",
      ),
    ],
  });

  const all = groups.flatMap((g) => g.fields);
  const fromEnv = all.filter((f) => f.fromEnv).length;

  return {
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    groups,
    counts: { total: all.length, fromEnv, defaults: all.length - fromEnv },
  };
}
