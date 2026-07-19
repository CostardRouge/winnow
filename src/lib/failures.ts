// Logging of SCAN failures (per-file indexing). Upsert by path:
// a file that fails repeatedly updates its row (attempts counter) and
// reopens the failure (resolved_at = NULL). resolveScanFailure() marks it resolved.
//
// The other failure families are already persisted elsewhere and read as-is
// by /api/failures: derivatives -> assets.derivative_status='error', import
// -> import_batches.result. So we only duplicate what was missing.
import { q, one } from "./db";
import { config } from "./config";

// The five failure families surfaced as tabs on /pipeline/failures.
export type FailureCounts = {
  derivative: number;
  scan: number;
  import: number;
  // Live assets whose ML analysis (faces/OCR/CLIP, cf. lib/ml.ts) errored —
  // ml_status='error'. Only surfaced when the ML feature is on (the caller
  // guards on config.ml.enabled), so a disabled stage never inflates the badge.
  ml: number;
  duplicates: number;
  // Indexed assets whose ORIGINAL is gone from disk (cf. lib/integrity.ts).
  // Counted while awaiting triage (not yet purged) — the auto-trashed ones
  // included, since restoring or purging them is still a pending decision.
  missing: number;
};

// Single source of truth for the failure-family counters, so the aggregate
// "Failures" badge (via /api/stats) always equals the sum of the subsection
// tabs (via /api/failures) — they used to be computed independently and drift
// apart (deduplication was missing from the aggregate entirely; derivative and
// import were scoped differently on each side).
//   - derivative : live-library assets stuck in derivative error,
//   - scan       : open per-file scan failures,
//   - import     : files that failed import, summed across every batch,
//   - duplicates : recorded duplicate hits still awaiting triage,
//   - missing    : originals gone from disk, awaiting restore/purge triage.
// Each family is guarded on its own so a table missing before migration yields
// 0 for that family rather than zeroing (or 500-ing) the others.
export async function failureCounts(): Promise<FailureCounts> {
  const counts: FailureCounts = {
    derivative: 0,
    scan: 0,
    import: 0,
    ml: 0,
    duplicates: 0,
    missing: 0,
  };
  try {
    const r = await one<{ n: number }>(
      "SELECT count(*) AS n FROM assets WHERE derivative_status = 'error' AND deleted_at IS NULL",
    );
    counts.derivative = Number(r?.n ?? 0);
  } catch {
    /* best-effort */
  }
  try {
    const r = await one<{ n: number }>(
      "SELECT count(*) AS n FROM scan_failures WHERE resolved_at IS NULL",
    );
    counts.scan = Number(r?.n ?? 0);
  } catch {
    /* table absent before migration */
  }
  try {
    const r = await one<{ n: number }>(
      "SELECT COALESCE(sum(failed), 0) AS n FROM import_batches WHERE failed > 0",
    );
    counts.import = Number(r?.n ?? 0);
  } catch {
    /* table absent before migration */
  }
  // ML errors are only a "failure" when the feature is on; with ML off the
  // stage can't progress and its errored rows shouldn't inflate the badge (the
  // /pipeline/failures ML tab is likewise gated on mlEnabled).
  if (config.ml.enabled) {
    try {
      const r = await one<{ n: number }>(
        "SELECT count(*) AS n FROM assets WHERE ml_status = 'error' AND deleted_at IS NULL",
      );
      counts.ml = Number(r?.n ?? 0);
    } catch {
      /* column absent before migration */
    }
  }
  try {
    const r = await one<{ n: number }>(
      "SELECT count(*) AS n FROM duplicate_hits",
    );
    counts.duplicates = Number(r?.n ?? 0);
  } catch {
    /* table absent before migration */
  }
  try {
    const r = await one<{ n: number }>(
      "SELECT count(*) AS n FROM assets WHERE missing_at IS NOT NULL AND purged_at IS NULL",
    );
    counts.missing = Number(r?.n ?? 0);
  } catch {
    /* column absent before migration */
  }
  return counts;
}

export async function recordScanFailure(
  absPath: string,
  rootId: number | null,
  error: string,
): Promise<void> {
  try {
    await q(
      `INSERT INTO scan_failures (abs_path, root_id, error)
       VALUES ($1, $2, $3)
       ON CONFLICT (abs_path) DO UPDATE
         SET error = EXCLUDED.error,
             root_id = EXCLUDED.root_id,
             attempts = scan_failures.attempts + 1,
             updated_at = now(),
             resolved_at = NULL`,
      [absPath, rootId, error.slice(0, 1000)],
    );
  } catch (err) {
    // Never let a scan fail because of the logging itself.
    console.warn("recordScanFailure:", (err as Error).message);
  }
}

export async function resolveScanFailure(absPath: string): Promise<void> {
  try {
    await q(
      "UPDATE scan_failures SET resolved_at = now() WHERE abs_path = $1 AND resolved_at IS NULL",
      [absPath],
    );
  } catch {
    /* best-effort */
  }
}
