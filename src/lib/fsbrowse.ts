// Server-side folder picker for the Volumes "Add folder" modal.
//
// Lists the SUBDIRECTORIES of a path so the user can browse the NAS and pick a
// folder instead of typing "/" by hand. Navigation is confined to a set of
// browse roots (the NAS mount + the configured volume dirs); the OS tree
// (/etc, /usr, …) is never reachable, and symlinks can't escape the bounds
// (we resolve realpath and re-check containment). Directories only, one
// `readdir` per navigation — we keep NAS I/O minimal (guiding principle).
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { config, isIgnoredEntry } from "./config";
import { normalizeRootPath } from "./volumes";

// Thrown for user-fixable problems (out of bounds, missing folder) → HTTP 400.
export class BrowseError extends Error {}

export type FsEntry = { name: string; path: string };
export type FsListing = {
  // "" = the virtual root: `entries` then lists the browse roots themselves.
  path: string;
  // null when at the virtual root or at a browse root (can't go higher).
  parent: string | null;
  roots: string[];
  entries: FsEntry[];
};

// Allowed browse bases: BROWSE_ROOTS ∪ the configured volume dirs, normalized,
// de-duplicated, sorted — minus anything empty or "/".
export function browseRoots(): string[] {
  const { incomingDir, finalsDirs } = config.import;
  const all = [
    ...config.browse.roots,
    incomingDir,
    ...finalsDirs,
    config.exportDir,
  ]
    .filter(Boolean)
    .map(normalizeRootPath)
    .filter((p) => p && p !== "/");
  return [...new Set(all)].sort();
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root + "/");
}

// Logical containment check: is `target` inside one of the browse roots? Used as
// defense-in-depth before a destructive filesystem action (e.g. deleting a
// recorded duplicate), so a stray path can never reach outside the area Winnow
// is allowed to touch. Purely logical (no realpath/stat) so it still answers for
// a file that has already been removed — letting callers clean up its stale row.
export function isWithinBrowseRoots(target: string): boolean {
  const resolved = normalizeRootPath(target);
  return browseRoots().some((r) => within(resolved, r));
}

export async function listDir(input?: string): Promise<FsListing> {
  const roots = browseRoots();

  // Virtual root: no path yet → offer the browse roots as the starting choices.
  if (!input || !input.trim()) {
    return {
      path: "",
      parent: null,
      roots,
      entries: roots.map((p) => ({ name: p, path: p })),
    };
  }

  const requested = normalizeRootPath(input);
  if (!requested.startsWith("/"))
    throw new BrowseError("Absolute path required.");
  // Fast logical containment check before touching the filesystem.
  if (!roots.some((r) => within(requested, r)))
    throw new BrowseError("This folder is outside the browsable area.");

  // Resolve symlinks and re-check, so a symlink inside a root can't point out
  // of bounds (e.g. /nas/link → /etc).
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new BrowseError("Folder not found.");
  }
  const realRoots = await Promise.all(
    roots.map((r) => realpath(r).catch(() => r)),
  );
  if (!realRoots.some((r) => within(real, r)))
    throw new BrowseError("This folder is outside the browsable area.");

  let dirents;
  try {
    dirents = await readdir(requested, { withFileTypes: true });
  } catch (err) {
    throw new BrowseError(`Can't read this folder: ${(err as Error).message}`);
  }

  const entries = dirents
    .filter((d) => d.isDirectory() && !isIgnoredEntry(d.name))
    .map((d) => ({
      name: d.name,
      path: normalizeRootPath(path.join(requested, d.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Parent stays in bounds (dirname of something under a root is ≥ the root);
  // null when `requested` is itself a browse root (go back to the locations).
  const isRootLevel = roots.includes(requested);
  const parent = isRootLevel ? null : normalizeRootPath(path.dirname(requested));

  return { path: requested, parent, roots, entries };
}
