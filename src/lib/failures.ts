// Logging of SCAN failures (per-file indexing). Upsert by path:
// a file that fails repeatedly updates its row (attempts counter) and
// reopens the failure (resolved_at = NULL). resolveScanFailure() marks it resolved.
//
// The other failure families are already persisted elsewhere and read as-is
// by /api/failures: derivatives -> assets.derivative_status='error', import
// -> import_batches.result. So we only duplicate what was missing.
import { q } from "./db";

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
