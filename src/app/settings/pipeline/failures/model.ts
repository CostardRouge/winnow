// Shared shapes for the Settings › Pipeline › Failures section. Each failure
// family lives on its own sub-route (/settings/pipeline/failures/{analyze,
// scan, import, ml, duplicates, missing}); they all read the same
// GET /api/failures payload, typed here — except deduplication, whose listing
// is far too large to ride that poll and has its own endpoint + types
// (GET /api/failures/duplicates, src/lib/duplicateList.ts).

export type DerivItem = {
  asset_id: number;
  filename: string;
  abs_path: string;
  media_type: string;
  error: string | null;
  updated_at: string;
};
export type ScanItem = {
  abs_path: string;
  error: string;
  attempts: number;
  updated_at: string;
};
// A live asset whose ML analysis (faces/OCR/CLIP, cf. lib/ml.ts) errored — the
// message is stored in ml_error.
export type MlItem = {
  asset_id: number;
  filename: string;
  abs_path: string;
  media_type: string;
  error: string | null;
  updated_at: string;
};
export type ImportItem = {
  batch_id: number;
  origin: string | null;
  file: string;
  error: string;
  created_at: string;
};
// An indexed asset whose ORIGINAL is gone from disk (cf. lib/integrity.ts).
// `trashed` = auto-trashed by the detector (reversible); false = only flagged
// (mass-disappearance guard) and still visible in the library.
export type MissingItem = {
  asset_id: number;
  filename: string;
  abs_path: string;
  media_type: string;
  file_size: number | null;
  missing_at: string;
  trashed: boolean;
  // Why the last purge refused this row (cf. lib/purge.ts), when it did — the
  // row stays in the trash and would otherwise look like nothing happened.
  purge_error: string | null;
};
export type Failures = {
  derivative: { count: number; items: DerivItem[] };
  scan: { count: number; items: ScanItem[] };
  import: { count: number; items: ImportItem[] };
  ml: { count: number; items: MlItem[] };
  missing: { count: number; items: MissingItem[] };
};

// --- Relink (moved originals) ----------------------------------------------
//
// Mirrors lib/relink.ts's report over the wire. Re-declared here rather than
// imported so nothing pulls that server-only module (config, pg, node:fs) into
// the client bundle — same reason every other shape above is re-declared.
// `matches`/`skipped` are capped previews; `matched`/`skippedCount` are exact.
export type RelinkMatch = {
  assetId: number;
  filename: string;
  oldPath: string;
  newPath: string;
  state: "purged" | "trashed" | "flagged";
  fileSize: number | null;
  needsRebuild: boolean;
};
export type RelinkReport = {
  applied: boolean;
  orphans: number;
  scanned: number;
  unindexed: number;
  hashed: number;
  matched: number;
  matches: RelinkMatch[];
  rebuilds: number;
  relinked: number;
  ambiguous: number;
  skippedCount: number;
  skipped: { path: string; reason: string }[];
  derivativesQueued: number;
  sidecarsRecorded: number;
};
export type RelinkRootReport = {
  root: { id: number; path: string; kind: string };
  report: RelinkReport;
};
// A queued relink pass, as GET /api/failures/relink?job_id= returns it. The
// report only exists once `state` is "completed".
export type RelinkJobInfo = {
  id: string;
  state: string;
  data: { rootId: number | null; apply: boolean } | null;
  result: { perRoot: RelinkRootReport[] } | null;
  failedReason: string | null;
};

export type Kind = "derivative" | "scan" | "import" | "missing" | "ml";
export type Scope = { ids?: number[]; paths?: string[] };

export type RowData<K extends string | number> = {
  key: K;
  title: string;
  path?: string;
  error: string;
  when: string;
  badge?: string;
  // When the failure maps to an indexed asset, a link to download its original
  // file (so an item that can't be previewed can still be inspected locally).
  downloadHref?: string;
};

// Bytes → short human size (1 decimal). Mirrors the compact figures elsewhere.
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}
