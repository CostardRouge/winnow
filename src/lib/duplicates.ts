// Audit log of deduplication hits (review §4). Every time a file is matched as
// a duplicate by its partial content_hash, we record it here so the decision is
// never silent: a confirmed duplicate, a recovered FALSE collision (distinct
// content, indexed anyway), or an unverified match are all traceable from
// /failures.
//
// Upsert by abs_path (like scan_failures): a path re-seen on each incremental
// scan updates its row + a hits counter instead of accumulating.
import { q } from "./db";
import { createLogger } from "./log";

const log = createLogger("dedup");

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
    log.warn("recordDuplicateHit failed", { err });
  }
}
