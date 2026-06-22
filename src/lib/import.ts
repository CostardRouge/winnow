// Import worker — common feeder for all sources (web upload, SMB drop,
// device FTP, card offload). Contract: bytes arrive in a
// `sourceDir`; we VERIFY them (hash), DEDUPLICATE them (content_hash shared with
// the assets), FILE them into the incoming (NAS archive) according to a
// deterministic template, then let the indexer do its usual work.
import {
  readdir,
  stat,
  mkdir,
  copyFile,
  rename,
  rm,
  rmdir,
  access,
} from "node:fs/promises";
import path from "node:path";
import { q, one } from "./db";
import { config, classifyExt, isIgnoredEntry } from "./config";
import { partialHash, sameContent } from "./hash";
import { readMetadata } from "./extract";
import { enqueueIndex, PRIORITY } from "./queue";
import { recordDuplicateHit } from "./duplicates";
import { findSidecars } from "./sidecars";
import { slug } from "./slug";

// HIDDEN subfolders of the inbox (prefix ". ") — therefore ignored both by
// the watcher and by the import walk of the entire inbox:
//   .uploads : staging area for web uploads (imported explicitly, by batch) → avoids
//              the double trigger of watcher + batch import on the same bytes.
//   .failed  : quarantine for failed files → no longer retried in a
//              loop on every drop; manually retryable.
export const uploadStagingDir = path.join(config.import.inboxDir, ".uploads");
export const quarantineDir = path.join(config.import.inboxDir, ".failed");

export type ImportOrigin = "web_upload" | "card_offload" | "inbox" | "ftp";

export type ImportArgs = {
  sourceDir: string;
  origin: ImportOrigin;
  removeAfter: boolean; // true for inbox/upload, false for a card
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
    // Hidden entries (incl. the inbox's .uploads/.failed) + NAS junk trees
    // (Synology @eaDir, #recycle) — same noise the indexer prunes.
    if (isIgnoredEntry(entry.name)) continue;
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

// Deterministic template: {incoming}/{device}/{YYYY}/{YYYY-MM-DD}/{file}.
// Grouping by day/device creates natural "sessions" that the indexer
// picks up as-is.
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

// Filename minus its extension.
function baseName(filename: string): string {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, filename.length - ext.length) : filename;
}

// Carry the Sony video sidecars (C0001M01.XML / C0001.THM …) next to a clip we
// just filed, renaming each to track the video's final (possibly collision-
// suffixed) name so the base⇔base link survives. Best-effort: a sidecar is a
// nicety and must NEVER fail or abort the import of the video itself.
async function carrySidecars(
  srcVideo: string,
  destVideo: string,
  removeAfter: boolean,
): Promise<void> {
  const srcDir = path.dirname(srcVideo);
  let siblings: string[];
  try {
    siblings = (await readdir(srcDir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return;
  }
  const matches = findSidecars(path.basename(srcVideo), siblings);
  if (!matches.length) return;

  const destDir = path.dirname(destVideo);
  const destBase = baseName(path.basename(destVideo));
  for (const m of matches) {
    const srcSc = path.join(srcDir, m.filename);
    const destSc = path.join(destDir, destBase + m.suffix);
    try {
      // Don't clobber an existing sidecar at the destination (re-import): the
      // name already encodes the video, so leaving it is correct.
      if (!(await exists(destSc))) {
        const tmp = `${destSc}.part`;
        await rm(tmp, { force: true });
        await copyFile(srcSc, tmp);
        const [s1, s2] = await Promise.all([stat(srcSc), stat(tmp)]);
        if (s1.size !== s2.size) {
          await rm(tmp, { force: true });
          continue;
        }
        await rename(tmp, destSc);
      }
      if (removeAfter) await rm(srcSc, { force: true });
    } catch {
      /* best-effort: never let a sidecar break the video's import */
    }
  }
}

// Avoids overwriting a different file with the same name: we add a suffix.
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
    if (!classifyExt(ext)) continue; // not a recognized media: we leave it in place

    try {
      const st = await stat(src);
      const hash = await partialHash(src, st.size);

      // Deduplication: same partial content_hash already known. Verify the FULL
      // content before discarding (and possibly deleting) the source — a false
      // partial-hash collision would otherwise silently lose a distinct shot
      // (review §4).
      const dup = await one<{ id: number; abs_path: string }>(
        "SELECT id, abs_path FROM assets WHERE content_hash = $1",
        [hash],
      );
      if (dup) {
        const same = await sameContent(src, dup.abs_path);
        await recordDuplicateHit({
          absPath: src,
          contentHash: hash,
          existingAssetId: dup.id,
          source: "import",
          verified: same,
          fileSize: st.size,
        });
        if (same !== false) {
          // Confirmed (or unverifiable) duplicate: copy nothing.
          res.duplicates++;
          if (args.removeAfter) await rm(src, { force: true });
          continue;
        }
        // FALSE collision: fall through and import it normally. The indexer
        // will later store it with a NULL content_hash.
      }

      const meta = await readMetadata(src);
      const planned = planDestination(
        meta.device,
        meta.captured_at,
        path.basename(src),
      );

      // If the destination already exists with the same content, it is already imported.
      if (await exists(planned)) {
        const existSt = await stat(planned);
        const existHash = await partialHash(planned, existSt.size);
        if (existHash === hash) {
          // Same partial hash as the file already on disk: confirm before
          // treating it as a duplicate (review §4).
          const same = await sameContent(src, planned);
          if (same !== false) {
            await recordDuplicateHit({
              absPath: src,
              contentHash: hash,
              existingAssetId: null,
              source: "import",
              verified: same,
              fileSize: st.size,
            });
            res.duplicates++;
            if (args.removeAfter) await rm(src, { force: true });
            continue;
          }
          // FALSE collision at the destination path: keep both — uniqueDest()
          // below picks a non-colliding filename.
          await recordDuplicateHit({
            absPath: src,
            contentHash: hash,
            existingAssetId: null,
            source: "import",
            verified: false,
            fileSize: st.size,
          });
        }
      }
      const dest = await uniqueDest(planned);

      await mkdir(path.dirname(dest), { recursive: true });

      // Atomic copy: write into a `.part`, verify (size + partial
      // hash), then rename — a crash in progress never leaves a partial
      // file under the final name (which would then be indexed as valid).
      const tmp = `${dest}.part`;
      await rm(tmp, { force: true });
      await copyFile(src, tmp);
      const destSt = await stat(tmp);
      const destHash = await partialHash(tmp, destSt.size);
      if (destSt.size !== st.size || destHash !== hash) {
        await rm(tmp, { force: true });
        throw new Error("copy verification failed (size/hash)");
      }
      await rename(tmp, dest);

      // Sony writes a metadata sidecar next to each video clip — carry it along
      // so the clip and its companion stay together in the incoming archive.
      if (classifyExt(ext)?.mediaType === "video") {
        await carrySidecars(src, dest, args.removeAfter);
      }

      if (args.removeAfter) await rm(src, { force: true });
      res.imported++;
    } catch (err) {
      res.failed++;
      res.errors.push({ file: src, error: (err as Error).message });
      // Quarantine: we move the file out of the inbox so as not to retry it in
      // a loop on every drop. (Not for a card: removeAfter=false leaves it
      // intact; nor for a file already quarantined, which we leave in place.)
      if (args.removeAfter && !src.startsWith(quarantineDir)) {
        try {
          await mkdir(quarantineDir, { recursive: true });
          const dest = await uniqueDest(
            path.join(quarantineDir, path.basename(src)),
          );
          await rename(src, dest).catch(async () => {
            await copyFile(src, dest);
            await rm(src, { force: true });
          });
        } catch {
          /* last resort: we leave the file (will be retried) */
        }
      }
    }
  }

  // Upload staging area emptied after import: we remove the batch folder (rmdir
  // only deletes if it is empty — any failures are already in quarantine).
  if (args.removeAfter && args.sourceDir.startsWith(uploadStagingDir)) {
    await rmdir(args.sourceDir).catch(() => {});
  }

  // The incoming is a "source" root: we register it and enqueue indexing
  // (incremental: only new files will be processed).
  if (res.imported > 0) {
    const root = await one<{ id: number }>(
      `INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', true)
       ON CONFLICT (path) DO UPDATE SET path = EXCLUDED.path
       RETURNING id`,
      [config.import.incomingDir],
    );
    // The incoming (from an import) takes priority over ordinary scans.
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
