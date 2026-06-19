// Import worker — feeder commun à toutes les sources (upload web, dépôt SMB,
// FTP appareil, offload de carte). Contrat : des octets arrivent dans un
// `sourceDir` ; on les VÉRIFIE (hash), on DÉDUPLIQUE (content_hash partagé avec
// les assets), on RANGE dans l'incoming (archive NAS) selon un gabarit
// déterministe, puis on laisse l'indexer faire son travail habituel.
import {
  readdir,
  stat,
  mkdir,
  copyFile,
  rename,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import { q, one } from "./db";
import { config, classifyExt } from "./config";
import { partialHash } from "./hash";
import { readMetadata } from "./extract";
import { enqueueIndex, PRIORITY } from "./queue";
import { slug } from "./slug";

export type ImportOrigin = "web_upload" | "card_offload" | "inbox" | "ftp";

export type ImportArgs = {
  sourceDir: string;
  origin: ImportOrigin;
  removeAfter: boolean; // true pour inbox/upload, false pour une carte
  batchId?: number;
};

export type ImportResult = {
  imported: number;
  duplicates: number;
  failed: number;
  errors: Array<{ file: string; error: string }>;
};

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Gabarit déterministe : {incoming}/{device}/{YYYY}/{YYYY-MM-DD}/{fichier}.
// Le regroupement par jour/appareil crée des "sessions" naturelles que l'indexer
// reprend telles quelles.
function planDestination(
  device: string | null,
  capturedAtIso: string | null,
  filename: string,
): string {
  const when = capturedAtIso ? new Date(capturedAtIso) : new Date();
  const valid = !Number.isNaN(when.getTime()) ? when : new Date();
  const yyyy = String(valid.getUTCFullYear());
  const mm = String(valid.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(valid.getUTCDate()).padStart(2, "0");
  return path.join(
    config.import.incomingDir,
    slug(device ?? "unknown"),
    yyyy,
    `${yyyy}-${mm}-${dd}`,
    filename,
  );
}

// Évite d'écraser un fichier différent portant le même nom : on suffixe.
async function uniqueDest(dest: string): Promise<string> {
  if (!(await exists(dest))) return dest;
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${base}__${i}${ext}`;
    if (!(await exists(cand))) return cand;
  }
  return `${base}__${Date.now()}${ext}`;
}

export async function runImport(args: ImportArgs): Promise<ImportResult> {
  const res: ImportResult = {
    imported: 0,
    duplicates: 0,
    failed: 0,
    errors: [],
  };

  if (args.batchId) {
    await q("UPDATE import_batches SET status='running' WHERE id=$1", [
      args.batchId,
    ]);
  }

  for await (const src of walk(args.sourceDir)) {
    const ext = path.extname(src);
    if (!classifyExt(ext)) continue; // pas un média reconnu : on laisse en place

    try {
      const st = await stat(src);
      const hash = await partialHash(src, st.size);

      // Déduplication : même content_hash déjà connu → on ne recopie rien.
      const dup = await one<{ id: number }>(
        "SELECT id FROM assets WHERE content_hash = $1",
        [hash],
      );
      if (dup) {
        res.duplicates++;
        if (args.removeAfter) await rm(src, { force: true });
        continue;
      }

      const meta = await readMetadata(src);
      const planned = planDestination(
        meta.device,
        meta.captured_at,
        path.basename(src),
      );

      // Si la destination existe déjà avec le même contenu, c'est déjà importé.
      if (await exists(planned)) {
        const existSt = await stat(planned);
        const existHash = await partialHash(planned, existSt.size);
        if (existHash === hash) {
          res.duplicates++;
          if (args.removeAfter) await rm(src, { force: true });
          continue;
        }
      }
      const dest = await uniqueDest(planned);

      await mkdir(path.dirname(dest), { recursive: true });

      // Copie atomique : écriture dans un `.part`, vérification (taille + hash
      // partiel), puis rename — un crash en cours ne laisse jamais de fichier
      // partiel sous le nom final (qui serait ensuite indexé comme valide).
      const tmp = `${dest}.part`;
      await rm(tmp, { force: true });
      await copyFile(src, tmp);
      const destSt = await stat(tmp);
      const destHash = await partialHash(tmp, destSt.size);
      if (destSt.size !== st.size || destHash !== hash) {
        await rm(tmp, { force: true });
        throw new Error("vérification de copie échouée (taille/hash)");
      }
      await rename(tmp, dest);

      if (args.removeAfter) await rm(src, { force: true });
      res.imported++;
    } catch (err) {
      res.failed++;
      res.errors.push({ file: src, error: (err as Error).message });
    }
  }

  // L'incoming est un root "source" : on l'enregistre et on enfile l'indexation
  // (incrémentale : seuls les nouveaux fichiers seront traités).
  if (res.imported > 0) {
    const root = await one<{ id: number }>(
      `INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', true)
       ON CONFLICT (path) DO UPDATE SET path = EXCLUDED.path
       RETURNING id`,
      [config.import.incomingDir],
    );
    // L'incoming (issu d'un import) est prioritaire sur les scans ordinaires.
    if (root) await enqueueIndex(root.id, { priority: PRIORITY.high });
  }

  if (args.batchId) {
    await q(
      `UPDATE import_batches
         SET status='done', imported=$2, duplicates=$3, failed=$4,
             finished_at=now(), result=$5
       WHERE id=$1`,
      [
        args.batchId,
        res.imported,
        res.duplicates,
        res.failed,
        JSON.stringify({ errors: res.errors.slice(0, 50) }),
      ],
    );
  }

  return res;
}
