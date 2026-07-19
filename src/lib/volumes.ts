// Volumes: the user-facing model behind the Volumes table + add modal.
//
// A "volume type" is how the user chooses to interpret a directory when they
// register it. It maps to a `roots.kind` (the DB source of truth):
//   incoming → 'source'  (walked + cullable)
//   final    → 'finals'  (walked, view-only)
//   export   → 'export'  (listed only, never walked)
// 'inbox' stays internal (the import drop zone) and is not an offered type.
import type { Root } from "./types";

export type VolumeType = "incoming" | "final" | "export";

export const VOLUME_TYPES: { value: VolumeType; label: string; hint: string }[] =
  [
    {
      value: "incoming",
      label: "Incoming",
      hint: "To cull — sessions land in the triage queue, derivatives are built.",
    },
    {
      value: "final",
      label: "Final",
      hint: "Finalized, view-only — indexed for browsing (thumbnails), never culled.",
    },
    {
      value: "export",
      label: "Export",
      hint: "Listed for visibility only — not indexed (RAW copies that mirror originals).",
    },
  ];

export function typeForKind(kind: Root["kind"]): VolumeType | "inbox" {
  if (kind === "finals") return "final";
  if (kind === "export") return "export";
  if (kind === "inbox") return "inbox";
  return "incoming";
}

export function kindForType(type: VolumeType): Root["kind"] {
  if (type === "final") return "finals";
  if (type === "export") return "export";
  return "source";
}

// Only source/finals roots are walked by the indexer. 'export' and 'inbox' are
// tracked/handled elsewhere and must never be enqueued for an indexing scan.
export function isWalkable(kind: Root["kind"]): boolean {
  return kind === "source" || kind === "finals";
}

// --- Path guards (avoid the "/ indexes the whole filesystem" footgun) -------

// Top-level system directories we refuse to register as a volume: indexing them
// would walk the OS/container, not the NAS media.
const FORBIDDEN = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
]);

// Normalize for comparison: collapse `//`, drop a trailing slash (but keep "/").
export function normalizeRootPath(p: string): string {
  const trimmed = p.trim().replace(/\/{2,}/g, "/");
  if (trimmed.length > 1 && trimmed.endsWith("/")) return trimmed.slice(0, -1);
  return trimmed;
}

// True if `a` is `b` or a parent/child of `b` (overlap ⇒ double indexing).
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

// Split a set of roots into the ones to actually walk and the ones to skip
// because another root already contains them. Overlapping roots are refused at
// registration (validateRootPath), but a pair can still coexist in the DB — a
// finals folder nested in the incoming tree seeded from the env, or a volume
// added before that guard existed. Scanning both walks every shared file twice,
// which races the content_hash INSERT and logs files as duplicates of
// themselves. We keep the OUTERMOST root of each overlap (it already covers the
// nested one's files) and drop the rest, naming the container for the caller to
// log. Pure + deterministic (ties broken by id) so bootstrap and the periodic
// rescan make the same choice.
export function dedupeOverlappingRoots<T extends { id: number; path: string }>(
  roots: T[],
): { kept: T[]; dropped: { root: T; coveredBy: T }[] } {
  const norm = roots.map((r) => ({ r, p: normalizeRootPath(r.path) }));
  const kept: T[] = [];
  const dropped: { root: T; coveredBy: T }[] = [];
  for (const { r, p } of norm) {
    // A strict ancestor in the set (its path is a parent dir of ours) means our
    // whole subtree is already walked by it. roots.path is UNIQUE, so equal
    // paths never occur here — only true nesting.
    const ancestor = norm.find(({ r: o, p: op }) => o.id !== r.id && p.startsWith(op + "/"));
    if (ancestor) dropped.push({ root: r, coveredBy: ancestor.r });
    else kept.push(r);
  }
  return { kept, dropped };
}

export type GuardResult = { ok: true; path: string } | { ok: false; reason: string };

// Validate a path the user wants to register, against the already-known roots.
// Authoritative server-side check (the modal also pre-checks for instant UX).
export function validateRootPath(
  raw: string,
  existing: { path: string }[] = [],
): GuardResult {
  const path = normalizeRootPath(raw);
  if (!path) return { ok: false, reason: "Path is required." };
  if (!path.startsWith("/"))
    return { ok: false, reason: "Use an absolute path (as seen inside the container, e.g. /nas/2026/…)." };
  if (FORBIDDEN.has(path))
    return {
      ok: false,
      reason: `"${path}" is a system directory — pick a NAS media folder (e.g. /nas/2026/…), not the filesystem root.`,
    };
  for (const r of existing) {
    const other = normalizeRootPath(r.path);
    if (other === path) continue; // same path = re-register (allowed, upsert)
    if (overlaps(path, other))
      return {
        ok: false,
        reason: `Overlaps an existing volume "${other}" — a folder can't be nested inside (or contain) another, that would index it twice.`,
      };
  }
  return { ok: true, path };
}
