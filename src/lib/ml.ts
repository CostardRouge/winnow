// ML analysis — detects FACES and reads the TEXT (OCR) in each media by sending
// its EXISTING derivative to a self-hosted machine-learning container over HTTP.
// Runs off its own BullMQ queue (cf. lib/queue.ts, worker.ts); this module owns
// the provider call and the per-asset job that writes the result.
//
// Why a container, and why the derivative: the NAS box already runs Immich's ML
// sidecar (immich-machine-learning) for its own library — reusing it means zero
// model management here and no Python in this stack. And the models only look at
// small inputs anyway (face detection ~640px, OCR ≤736px), so we send the WebP
// proxy/poster the pipeline already generated: the RAWs are never re-read, and an
// 80k-media backfill is 80k small HTTP calls, paced by the mlPerHour setting.
//
// IMPORTANT: the /predict API is Immich-INTERNAL and unversioned (the maintainers
// point at their own client code as the only reference). The shapes below match
// immich-machine-learning v2.2+ (OCR ships in v2.2.0). Pin the container image
// tag and re-check this contract when upgrading it. Reimplemented from the wire
// format — no Immich (AGPL) source is copied; consuming the HTTP API from this
// MIT app creates no license obligation (separate programs at arm's length).
import { config } from "./config";
import { getSettings } from "./settings";
import { one, q } from "./db";
import { reserveSlot, sleep } from "./rate";
import { getStorage } from "./storage/index";

// One detected face, normalized from the provider's response. The bounding box
// is in pixels of the ANALYZED image (the proxy/poster, not the original) —
// imgWidth/imgHeight carry that image's dimensions so the box can be projected
// onto any other rendition.
export type DetectedFace = {
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  embedding: number[] | null;
};

export type MlResult = {
  faces: DetectedFace[];
  // Every text fragment the OCR read, joined with newlines. Null when OCR is
  // disabled or nothing was read.
  ocrText: string | null;
  imgWidth: number | null;
  imgHeight: number | null;
};

// --- Provider: immich-machine-learning -------------------------------------
// POST {base}/predict, multipart: `entries` (JSON pipeline request) + `image`
// (bytes). Response carries one key per requested task plus the sent image's
// imageWidth/imageHeight.

type ImmichFace = {
  boundingBox: { x1: number; y1: number; x2: number; y2: number };
  // Serialized by the container as a JSON STRING (not an array).
  embedding: string | number[];
  score: number;
};

type ImmichPredictResponse = {
  "facial-recognition"?: ImmichFace[];
  // Parallel arrays: one entry per fragment read. `box` (flat, 8 floats per
  // quad, normalized 0..1) is not stored — we keep the text only.
  ocr?: { text: string[]; boxScore: number[]; textScore: number[] };
  imageWidth?: number;
  imageHeight?: number;
};

// The tasks we ask for, built from the config toggles. Shapes mirror what the
// Immich server itself sends (entries = { task: { modelType: { modelName, options } } }).
function buildEntries(): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  if (config.ml.faces.enabled) {
    entries["facial-recognition"] = {
      detection: {
        modelName: config.ml.faces.model,
        options: { minScore: config.ml.faces.minScore },
      },
      recognition: { modelName: config.ml.faces.model },
    };
  }
  if (config.ml.ocr.enabled) {
    entries["ocr"] = {
      detection: {
        modelName: config.ml.ocr.model,
        options: { minScore: 0.5, maxResolution: 736 },
      },
      recognition: {
        modelName: config.ml.ocr.model,
        options: { minScore: config.ml.ocr.minScore },
      },
    };
  }
  return entries;
}

// The container serializes embeddings as JSON strings; tolerate both spellings.
function parseEmbedding(v: string | number[] | undefined): number[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return null;
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? (arr as number[]) : null;
  } catch {
    return null;
  }
}

// One /predict HTTP call: both tasks ride a single request (one image decode
// container-side, one round trip).
async function immichPredict(image: Buffer): Promise<MlResult> {
  const base = config.ml.baseUrl.replace(/\/+$/, "");
  const form = new FormData();
  form.set("entries", JSON.stringify(buildEntries()));
  form.set("image", new Blob([new Uint8Array(image)]), "image");

  const res = await fetch(`${base}/predict`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(config.ml.timeoutMs),
  });
  if (!res.ok) {
    // 422 = the container didn't understand `entries` — most likely an OCR task
    // sent to a pre-v2.2 image. Make that diagnosable from /pipeline/failures.
    const detail = res.status === 422 ? " (container too old for a requested task? see ML_OCR_ENABLED)" : "";
    throw new Error(`ml HTTP ${res.status} from ${base}${detail}`);
  }
  const data = (await res.json()) as ImmichPredictResponse;

  const faces: DetectedFace[] = (data["facial-recognition"] ?? []).map((f) => ({
    score: f.score,
    x1: Math.round(f.boundingBox.x1),
    y1: Math.round(f.boundingBox.y1),
    x2: Math.round(f.boundingBox.x2),
    y2: Math.round(f.boundingBox.y2),
    embedding: parseEmbedding(f.embedding),
  }));

  const fragments = (data.ocr?.text ?? []).map((t) => t.trim()).filter(Boolean);
  return {
    faces,
    ocrText: fragments.length ? fragments.join("\n") : null,
    imgWidth: data.imageWidth ?? null,
    imgHeight: data.imageHeight ?? null,
  };
}

// Drip-feed throttle around the ONLY expensive part — the inference call. Same
// shared limiter as scan/analyze/geocode: paces the backfill so the ML box (often
// the same CPU as everything else) is never pinned. 0 = unlimited.
async function throttleMl(): Promise<void> {
  const { mlPerHour } = await getSettings();
  if (mlPerHour <= 0) return;
  let wait = await reserveSlot("ml", mlPerHour);
  while (wait > 0) {
    await sleep(Math.min(wait, 3000));
    wait = await reserveSlot("ml", mlPerHour);
  }
}

// Analyze (or re-analyze) one asset: read its derivative from storage, run the
// container's pipeline on it, replace the stored faces and OCR text wholesale.
// Idempotent — re-running simply refreshes the result.
export async function runMlJob(assetId: number): Promise<void> {
  const asset = await one<{
    id: number;
    media_type: "photo" | "video";
    thumb_key: string | null;
    proxy_key: string | null;
    derivative_status: string;
    deleted_at: string | null;
  }>(
    "SELECT id, media_type, thumb_key, proxy_key, derivative_status, deleted_at FROM assets WHERE id = $1",
    [assetId],
  );
  if (!asset || asset.deleted_at) return;

  // ML disabled: leave the asset 'pending' (don't error-storm the queue) so it
  // resolves once the feature is turned on and re-enqueued — same as geocode.
  if (!config.ml.enabled) return;

  // The models want an IMAGE: the photo proxy (2048px WebP), or the poster for a
  // video (its mp4 proxy is useless here). No derivative yet → not analyzable.
  const key =
    asset.media_type === "video"
      ? asset.thumb_key
      : (asset.proxy_key ?? asset.thumb_key);
  if (!key) {
    if (["error", "skipped"].includes(asset.derivative_status)) {
      // Terminal on the derivative side: nothing will ever be analyzable.
      await q(
        "UPDATE assets SET ml_status='skipped', ml_error=NULL, updated_at=now() WHERE id=$1",
        [assetId],
      );
      return;
    }
    // Derivative still pending/processing: this job raced generation. Let the
    // retry/backoff pick it up; generation re-enqueues ML on completion anyway.
    throw new Error("derivative not ready yet");
  }

  await q(
    "UPDATE assets SET ml_status='processing', updated_at=now() WHERE id=$1",
    [assetId],
  );

  try {
    const storage = await getStorage();
    const image = await storage.get(key);
    if (!image) throw new Error(`derivative bytes missing: ${key}`);

    await throttleMl();
    if (config.ml.provider !== "immich") {
      throw new Error(`Unsupported ml provider: ${config.ml.provider}`);
    }
    const result = await immichPredict(image);

    // Replace wholesale: a re-analysis (new model, regenerated derivative) must
    // never accumulate stale faces next to fresh ones.
    await q("DELETE FROM asset_faces WHERE asset_id=$1", [assetId]);
    for (const f of result.faces) {
      await q(
        `INSERT INTO asset_faces
           (asset_id, score, x1, y1, x2, y2, img_width, img_height, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          assetId,
          f.score,
          f.x1,
          f.y1,
          f.x2,
          f.y2,
          result.imgWidth,
          result.imgHeight,
          f.embedding ? JSON.stringify(f.embedding) : null,
        ],
      );
    }
    await q(
      `UPDATE assets SET
         face_count=$2, ocr_text=$3,
         ml_status='ready', ml_error=NULL, updated_at=now()
       WHERE id=$1`,
      [assetId, result.faces.length, result.ocrText],
    );
  } catch (err) {
    await q(
      "UPDATE assets SET ml_status='error', ml_error=$2, updated_at=now() WHERE id=$1",
      [assetId, (err as Error).message?.slice(0, 500) ?? "unknown error"],
    );
    throw err;
  }
}
