// ML-assisted culling analysis pass (Phase 1). Runs on the winnow-ml queue,
// AFTER the derivative is ready, reading the lightweight PROXY from storage —
// the RAW is never re-read. Decoupled from derivative generation so it can be
// paused, rate-limited and retried on its own, and so it can be back-filled over
// an existing library without regenerating a single thumbnail.
//
// Phase 1 computes a sharpness score and a perceptual hash, then folds the asset
// into a near-duplicate cluster. Later phases (aesthetic score, face / closed-eye
// detection) extend the same job + the asset_analysis row.
import { q, one } from "./db";
import { getStorage } from "./storage/index";
import { sharpnessScore, perceptualHash } from "./imageScore";
import { assignNearDupCluster } from "./neardup";

type AnalyzableAsset = {
  id: number;
  session_id: number;
  media_type: "photo" | "video";
  proxy_key: string | null;
  derivative_status: string;
  processing_state: string;
  deleted_at: string | null;
  group_role: "primary" | "companion" | null;
};

async function setStatus(
  assetId: number,
  status: "processing" | "ready" | "error",
  error: string | null = null,
): Promise<void> {
  await q(
    `INSERT INTO asset_analysis (asset_id, ml_status, ml_error, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (asset_id) DO UPDATE
       SET ml_status = EXCLUDED.ml_status,
           ml_error  = EXCLUDED.ml_error,
           updated_at = now()`,
    [assetId, status, error],
  );
}

export async function runMlAnalysis(assetId: number): Promise<void> {
  const asset = await one<AnalyzableAsset>(
    `SELECT id, session_id, media_type, proxy_key,
            derivative_status, processing_state, deleted_at, group_role
       FROM assets WHERE id = $1`,
    [assetId],
  );
  if (!asset) return;

  // Only analyse live photos whose proxy is ready. Videos, ignored, soft-deleted
  // or not-yet-derived assets are out of scope for Phase 1 — skip silently so a
  // stray queued job is a no-op (the enqueue points already filter, this is the
  // belt-and-braces guard, mirroring generateDerivative).
  if (
    asset.media_type !== "photo" ||
    asset.deleted_at ||
    asset.processing_state === "ignored" ||
    asset.derivative_status !== "ready" ||
    !asset.proxy_key
  ) {
    return;
  }

  await setStatus(assetId, "processing");
  try {
    const storage = await getStorage();
    const proxy = await storage.get(asset.proxy_key);
    if (!proxy) throw new Error(`proxy missing: ${asset.proxy_key}`);

    const [sharpness, phash] = await Promise.all([
      sharpnessScore(proxy),
      perceptualHash(proxy),
    ]);

    await q(
      `INSERT INTO asset_analysis
         (asset_id, ml_status, ml_error, sharpness, phash, analyzed_at, updated_at)
       VALUES ($1, 'ready', NULL, $2, $3, now(), now())
       ON CONFLICT (asset_id) DO UPDATE
         SET ml_status = 'ready', ml_error = NULL,
             sharpness = EXCLUDED.sharpness, phash = EXCLUDED.phash,
             analyzed_at = now(), updated_at = now()`,
      [assetId, sharpness, phash],
    );

    // Cluster look-alikes — but only for the logical media (primaries +
    // standalones), never a RAW companion: a RAW+JPEG pair is near-identical by
    // construction and is already tied as one media, so clustering its RAW half
    // would be noise. Best-effort: never fails the job.
    if (asset.group_role !== "companion") {
      await assignNearDupCluster(assetId, asset.session_id, phash);
    }
  } catch (err) {
    await setStatus(assetId, "error", (err as Error).message?.slice(0, 500) ?? "unknown error");
    throw err;
  }
}
