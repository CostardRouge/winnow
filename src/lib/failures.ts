// Journalisation des échecs de SCAN (indexation par fichier). Upsert par chemin :
// un fichier qui échoue à répétition met à jour sa ligne (compteur attempts) et
// rouvre l'échec (resolved_at = NULL). resolveScanFailure() marque réglé.
//
// Les autres familles d'échecs sont déjà persistées ailleurs et lues telles
// quelles par /api/failures : dérivés → assets.derivative_status='error', import
// → import_batches.result. On ne duplique donc que ce qui manquait.
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
    // Ne jamais faire échouer un scan à cause de la journalisation elle-même.
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
