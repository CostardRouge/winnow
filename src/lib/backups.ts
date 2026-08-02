// Backup dump files (Settings › Database). The `backup` compose sidecar takes
// the scheduled pg_dumps and drops them on the host; that dir is mounted
// READ-ONLY into the app container (config.backupsDir) so the UI can list and
// serve the dumps — never write or prune them (retention stays the sidecar's
// job, cf. docs/BACKUP.md).
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// Filenames as produced by the sidecar and scripts/pg-backup.sh. Also the ONLY
// shape the download route will serve: a strict allowlist (no separators, no
// dots outside the suffix) is what makes serving from a mounted dir safe —
// anything else in there (partials, strays) stays invisible.
export const DUMP_NAME_RE = /^winnow-[A-Za-z0-9_-]+\.sql\.gz$/;

export type BackupFile = { name: string; bytes: number; mtime: string };

export type BackupListing = {
  dir: string;
  mounted: boolean;
  files: BackupFile[];
};

export async function listBackups(): Promise<BackupListing> {
  const dir = config.backupsDir;
  try {
    const names = (await readdir(dir)).filter((n) => DUMP_NAME_RE.test(n));
    const files = await Promise.all(
      names.map(async (name) => {
        const s = await stat(path.join(dir, name));
        return { name, bytes: s.size, mtime: s.mtime.toISOString() };
      }),
    );
    files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return { dir, mounted: true, files: files.slice(0, 30) };
  } catch {
    // Dir not mounted into this container (or unreadable): the page explains
    // how to mount it instead of erroring.
    return { dir, mounted: false, files: [] };
  }
}

// Absolute path of a listed dump, or null when the name isn't a well-formed
// dump filename (the only gate needed: the regex forbids path separators).
export function backupFilePath(name: string): string | null {
  if (!DUMP_NAME_RE.test(name)) return null;
  return path.join(config.backupsDir, name);
}
