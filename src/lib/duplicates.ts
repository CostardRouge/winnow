// Audit log of deduplication hits (review §4). Every time a file is matched as
// a duplicate by its partial content_hash, we record it here so the decision is
// never silent: a confirmed duplicate, a recovered FALSE collision (distinct
// content, indexed anyway), or an unverified match are all traceable from
// /pipeline/failures.
//
// Upsert by abs_path (like scan_failures): a path re-seen on each incremental
// scan updates its row + a hits counter instead of accumulating.
import { rm } from "node:fs/promises";
import { q, many } from "./db";
import { isWithinBrowseRoots } from "./fsbrowse";

export type DuplicateSource = "index" | "import";

export async function recordDuplicateHit(args: {
  absPath: string;
  contentHash: string;
  existingAssetId: number | null;
  source: DuplicateSource;
  // true = confirmed identical, false = false collision, null = unverifiable.
  verified: boolean | null;
  fileSize: number | null;
}): Promise<void> {
  try {
    await q(
      `INSERT INTO duplicate_hits
         (abs_path, content_hash, existing_asset_id, source, verified, file_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (abs_path) DO UPDATE
         SET content_hash      = EXCLUDED.content_hash,
             existing_asset_id = EXCLUDED.existing_asset_id,
             source            = EXCLUDED.source,
             verified          = EXCLUDED.verified,
             file_size         = EXCLUDED.file_size,
             hits              = duplicate_hits.hits + 1,
             updated_at        = now()`,
      [
        args.absPath,
        args.contentHash,
        args.existingAssetId,
        args.source,
        args.verified,
        args.fileSize,
      ],
    );
  } catch (err) {
    // Never let auditing break a scan/import.
    console.warn("recordDuplicateHit:", (err as Error).message);
  }
}

export type DeleteDuplicatesResult = {
  deleted: string[];
  skipped: { path: string; reason: string }[];
};

// Hard-deletes the extra copies recorded in `duplicate_hits` (NOT a soft delete:
// these files were never indexed, so there is no asset row to hide — the file on
// disk is the only thing to remove). Three layers of safety, in order:
//   1. whitelist  — a path must be a recorded duplicate hit (no arbitrary path),
//   2. asset guard — never touch a path that is a live indexed asset (a kept
//      original or a recovered false collision: distinct content, must survive),
//   3. containment — the path must sit inside the browsable area (incoming/NAS).
// `rm(..., force)` treats an already-gone file as success so a stale row still
// gets cleaned. Resolved rows are dropped (the duplicate no longer exists).
export async function deleteDuplicateFiles(
  paths: string[],
): Promise<DeleteDuplicatesResult> {
  const result: DeleteDuplicatesResult = { deleted: [], skipped: [] };
  if (paths.length === 0) return result;

  const recorded = new Set(
    (
      await many<{ abs_path: string }>(
        "SELECT abs_path FROM duplicate_hits WHERE abs_path = ANY($1::text[])",
        [paths],
      )
    ).map((r) => r.abs_path),
  );
  const indexed = new Set(
    (
      await many<{ abs_path: string }>(
        "SELECT abs_path FROM assets WHERE abs_path = ANY($1::text[]) AND deleted_at IS NULL",
        [paths],
      )
    ).map((r) => r.abs_path),
  );

  const toDelete: string[] = [];
  for (const p of paths) {
    if (!recorded.has(p))
      result.skipped.push({ path: p, reason: "not a recorded duplicate" });
    else if (indexed.has(p))
      result.skipped.push({
        path: p,
        reason: "indexed in the library (kept) — not deleted",
      });
    else if (!isWithinBrowseRoots(p))
      result.skipped.push({ path: p, reason: "outside the allowed area" });
    else toDelete.push(p);
  }

  for (const p of toDelete) {
    try {
      await rm(p, { force: true });
      result.deleted.push(p);
    } catch (err) {
      result.skipped.push({ path: p, reason: (err as Error).message });
    }
  }

  if (result.deleted.length > 0) {
    await q("DELETE FROM duplicate_hits WHERE abs_path = ANY($1::text[])", [
      result.deleted,
    ]);
  }
  return result;
}
