// Enregistrement idempotent des roots connus, lancé au démarrage du worker.
//  - l'incoming (kind='source') : garantit l'indexation même sans import récent ;
//  - chaque dossier final configuré (kind='finals') : indexé pour la consultation
//    (miniatures), jamais trié — la lecture seule est imposée côté UI.
// Sans ce bootstrap, un dossier final resterait vide : auparavant les roots
// 'finals' n'étaient jamais indexés.
import { stat } from "node:fs/promises";
import { one } from "./db";
import { config } from "./config";
import { enqueueIndex } from "./queue";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureRoot(path: string, kind: "source" | "finals"): Promise<void> {
  const root = await one<{ id: number }>(
    `INSERT INTO roots (path, kind, watch) VALUES ($1, $2, true)
     ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`,
    [path, kind],
  );
  if (root) await enqueueIndex(root.id);
}

export async function bootstrapRoots(): Promise<void> {
  const { incomingDir, finalsDirs } = config.import;
  const dirs: Array<{ path: string; kind: "source" | "finals" }> = [];
  if (incomingDir) dirs.push({ path: incomingDir, kind: "source" });
  for (const d of finalsDirs) dirs.push({ path: d, kind: "finals" });

  for (const { path, kind } of dirs) {
    if (!(await exists(path))) {
      console.warn(`[bootstrap] ${kind} introuvable, ignoré : ${path}`);
      continue;
    }
    try {
      await ensureRoot(path, kind);
      console.log(`[bootstrap] ${kind} enregistré + indexation enfilée : ${path}`);
    } catch (err) {
      console.error(`[bootstrap] échec ${path} :`, err);
    }
  }
}
