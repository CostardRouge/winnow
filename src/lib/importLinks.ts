// Uploaded edits → the capture they were edited from (migration 0057).
//
// A client sending back a final names its source: `original_asset_id` on the
// multipart of POST /api/upload (lib/uploadLinkField.ts parses it). The link is
// written by the import itself, not by a later pass, because the client KNOWS
// the source — there is nothing to match. What makes it more than one UPDATE is
// timing: the import files the upload into the incoming by its own template,
// and the asset row only exists once the indexer walks that file. So:
//
//   1. the upload route checks the id (an existing asset, not in the trash) and
//      hands it to the import job with the staged file's path;
//   2. the importer records `filed path → source` in `import_links` once the
//      file is on disk — or, when the upload is a confirmed duplicate of a file
//      already in the library, links that asset at once;
//   3. the indexer, at the end of every scan, applies the pending rows whose
//      file has become an asset (`applyImportLinks`), and the importer runs the
//      same pass once more at its end for a file that was already indexed.
//
// Why not reconcile (lib/reconcile.ts — run after each scan, and on demand by
// the admin-only `POST /api/reconcile`): it GUESSES a link for files in a
// finals root from name and capture time. An upload lands in the incoming, a
// source root, so reconcile never even considers it — and the upload carries
// the answer anyway. The editor who may upload may link what they upload: the
// upload route stays editor (lib/authz.ts), `/api/reconcile` stays admin.
//
// Never overwrites: a row already linked keeps its link (as reconcile does),
// and every refusal is logged with its reason and returned in the import's
// report, never thrown — a bad id costs the link, never the upload.
import { one, q, tx } from "./db";

/** `assets.edit_match` for a link the uploading client stated. */
export const UPLOAD_MATCH = "upload";
/** A pending link whose file never became an asset is dropped after this. */
export const STALE_DAYS = 30;

export type LinkIgnored = {
  file: string;
  original_asset_id: number;
  reason: string;
};

/** Why `id` cannot be a link's source, or null when it can. */
export async function linkTargetProblem(id: number): Promise<string | null> {
  const row = await one<{ trashed: boolean }>(
    "SELECT deleted_at IS NOT NULL AS trashed FROM assets WHERE id = $1",
    [id],
  );
  if (!row) return `asset ${id} does not exist`;
  if (row.trashed) return `asset ${id} is in the trash`;
  return null;
}

// What the database says about one (file, source) pair at the moment of
// writing — the same shape for a duplicate linked at import time and for a
// pending row applied by the indexer, so both refuse for the same reasons.
type LinkState = {
  asset_id: number;
  asset_trashed: boolean;
  asset_original: number | null;
  source_exists: boolean;
  source_trashed: boolean;
};

/** "link", "done" (already this link: nothing to write), or a refusal. */
export function linkDecision(
  s: LinkState,
  originalId: number,
): "link" | "done" | { reason: string } {
  if (!s.source_exists) return { reason: `asset ${originalId} does not exist` };
  if (s.source_trashed) return { reason: `asset ${originalId} is in the trash` };
  if (Number(s.asset_id) === originalId)
    return { reason: "the uploaded file is the source asset itself" };
  if (s.asset_trashed) return { reason: "the uploaded file is in the trash" };
  if (s.asset_original != null) {
    return Number(s.asset_original) === originalId
      ? "done"
      : { reason: `already linked to asset ${s.asset_original}` };
  }
  return "link";
}

const STATE_COLUMNS = `
  a.id AS asset_id,
  a.deleted_at IS NOT NULL AS asset_trashed,
  a.original_asset_id AS asset_original,
  o.id IS NOT NULL AS source_exists,
  o.deleted_at IS NOT NULL AS source_trashed`;

function warn(file: string, originalId: number, reason: string): void {
  console.warn(
    `[import-links] original_asset_id ${originalId} ignored for ${file}: ${reason}`,
  );
}

/** Remembers that the file filed at `absPath` is an edit of `originalId`. */
export async function recordImportLink(
  absPath: string,
  originalId: number,
  batchId?: number,
): Promise<void> {
  await q(
    `INSERT INTO import_links (abs_path, original_asset_id, batch_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (abs_path) DO UPDATE
       SET original_asset_id = EXCLUDED.original_asset_id,
           batch_id = EXCLUDED.batch_id,
           created_at = now()`,
    [absPath, originalId, batchId ?? null],
  );
}

/**
 * Links an asset already in the library (the upload was a confirmed duplicate
 * of it) to `originalId`. Returns null when linked (or already so), else the
 * reason it was not — logged here.
 */
export async function linkExistingAsset(
  assetId: number,
  originalId: number,
  file: string,
): Promise<string | null> {
  return tx(async (c) => {
    const state = (
      await c.query<LinkState>(
        `SELECT ${STATE_COLUMNS}
           FROM assets a
           LEFT JOIN assets o ON o.id = $2
          WHERE a.id = $1
          FOR UPDATE OF a`,
        [assetId, originalId],
      )
    ).rows[0];
    const decision = state
      ? linkDecision(state, originalId)
      : { reason: `asset ${assetId} no longer exists` };
    if (decision === "done") return null;
    if (decision !== "link") {
      warn(file, originalId, decision.reason);
      return decision.reason;
    }
    await c.query(
      `UPDATE assets SET original_asset_id = $2, edit_match = $3, updated_at = now()
        WHERE id = $1`,
      [assetId, originalId, UPLOAD_MATCH],
    );
    return null;
  });
}

export type ApplyResult = {
  linked: number;
  ignored: LinkIgnored[];
  // Still waiting for the indexer to meet their file.
  pending: number;
};

/**
 * Writes every pending link whose file is now an asset, and drops the rows it
 * settled (linked or refused) plus those older than STALE_DAYS. Cheap: the
 * table only ever holds the uploads of the last few minutes. Concurrent scans
 * skip each other's locked rows rather than wait. `paths` scopes the pass to
 * one import's files, so its report names only its own.
 */
export async function applyImportLinks(
  opts: { paths?: string[] } = {},
): Promise<ApplyResult> {
  return tx(async (c) => {
    const rows = (
      await c.query<
        Partial<LinkState> & {
          abs_path: string;
          original_asset_id: number;
          stale: boolean;
        }
      >(
        `SELECT l.abs_path, l.original_asset_id,
                l.created_at < now() - make_interval(days => $1) AS stale,
                ${STATE_COLUMNS}
           FROM import_links l
           LEFT JOIN assets a ON a.abs_path = l.abs_path
           LEFT JOIN assets o ON o.id = l.original_asset_id
          WHERE $2::text[] IS NULL OR l.abs_path = ANY($2::text[])
          ORDER BY l.created_at
          FOR UPDATE OF l SKIP LOCKED`,
        [STALE_DAYS, opts.paths ?? null],
      )
    ).rows;

    const out: ApplyResult = { linked: 0, ignored: [], pending: 0 };
    const settled: string[] = [];
    const linkIds: number[] = [];
    const linkTo: number[] = [];
    for (const r of rows) {
      const originalId = Number(r.original_asset_id);
      if (r.asset_id == null) {
        if (!r.stale) {
          out.pending++;
          continue;
        }
        const reason = `no asset appeared at this path within ${STALE_DAYS} days`;
        warn(r.abs_path, originalId, reason);
        out.ignored.push({ file: r.abs_path, original_asset_id: originalId, reason });
        settled.push(r.abs_path);
        continue;
      }
      settled.push(r.abs_path);
      const decision = linkDecision(r as LinkState, originalId);
      if (decision === "done") continue;
      if (decision === "link") {
        linkIds.push(Number(r.asset_id));
        linkTo.push(originalId);
        continue;
      }
      warn(r.abs_path, originalId, decision.reason);
      out.ignored.push({
        file: r.abs_path,
        original_asset_id: originalId,
        reason: decision.reason,
      });
    }

    if (linkIds.length) {
      const upd = await c.query(
        `UPDATE assets a
            SET original_asset_id = v.original_id, edit_match = $3,
                updated_at = now()
           FROM unnest($1::bigint[], $2::bigint[]) AS v(id, original_id)
          WHERE a.id = v.id AND a.original_asset_id IS NULL`,
        [linkIds, linkTo, UPLOAD_MATCH],
      );
      out.linked = upd.rowCount ?? 0;
    }
    if (settled.length) {
      await c.query("DELETE FROM import_links WHERE abs_path = ANY($1::text[])", [
        settled,
      ]);
    }
    return out;
  });
}
