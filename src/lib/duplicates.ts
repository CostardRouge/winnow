// Audit log of deduplication hits (review §4). Every time a file is matched as
// a duplicate by its partial content_hash, we record it here so the decision is
// never silent: a confirmed duplicate, a recovered FALSE collision (distinct
// content, indexed anyway), or an unverified match are all traceable from
// /pipeline/failures.
//
// Upsert by abs_path (like scan_failures): a path re-seen on each incremental
// scan updates its row + a hits counter instead of accumulating.
import { rm, stat } from "node:fs/promises";
import { q, one, many } from "./db";
import { config } from "./config";
import { isWithinBrowseRoots } from "./fsbrowse";
import { getStorage } from "./storage/index";
import { normalizeRootPath } from "./volumes";

// Thrown for user-fixable problems while resolving a duplicate group (the chosen
// survivor isn't part of the group, sits outside the browsable area, …) → mapped
// to HTTP 400 by the route rather than a 500.
export class DuplicateError extends Error {}

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

// --- View-only volumes ------------------------------------------------------
//
// Final (the finished masters, kind 'finals') and Export volumes are view-only
// everywhere in the app: the purge worker refuses to unlink anything on them
// (lib/purge.ts, PURGEABLE_KINDS = source/inbox) and DELETE /api/sessions/:id
// carries the same guard. Deduplication must refuse them too, or it becomes the
// one path that reaches around that rule and removes a finalized master —
// "Keep only this" on an incoming copy would relink the library entry off the
// final and unlink it. A final copy is always the one that survives; the extra
// copies sitting in the cullable zone are what deduplication removes.
//
// Resolution is by PATH, since an on-disk duplicate has no session (hence no
// root) to join: the registered roots are the source of truth for a volume's
// kind, with the configured FINALS_DIRS / EXPORT_DIR as a fallback for a
// directory that is browsable but not registered as a root.
export const VIEW_ONLY_REASON =
  "on a view-only volume (Final/Export) — never deleted";

async function viewOnlyRoots(): Promise<string[]> {
  const rows = await many<{ path: string }>(
    "SELECT path FROM roots WHERE kind IN ('finals', 'export')",
  ).catch(() => [] as { path: string }[]);
  return [
    ...rows.map((r) => r.path),
    ...config.import.finalsDirs,
    config.exportDir,
  ]
    .filter(Boolean)
    .map(normalizeRootPath)
    .filter((p) => p && p !== "/");
}

function isUnder(target: string, roots: string[]): boolean {
  const t = normalizeRootPath(target);
  return roots.some((r) => t === r || t.startsWith(r + "/"));
}

// One roots lookup, then a synchronous predicate — for listing a whole page of
// duplicates (cf. /api/failures) so the UI can mark the protected copies and
// stop offering an action that would be refused anyway.
export async function viewOnlyChecker(): Promise<(path: string) => boolean> {
  const roots = await viewOnlyRoots();
  return (path: string) => isUnder(path, roots);
}

// Reclaim the row of a TRASHED asset whose original we just removed while
// resolving a duplicate group. Deduplication may drop a copy that is already in
// the recycle bin (the user culled the media; only the file lingered), but the
// row must then follow the exact contract of the purge worker (lib/purge.ts):
// the asset row is NEVER deleted — `purged_at` marks the bytes as gone while
// `deleted_at` keeps it hidden — its cached derivatives go with the original,
// and the removal is recorded in `purge_log` so the reclaim ledger stays honest.
//
// It also RELEASES the content_hash (unique index, migration 0001). A purged row
// still holding the hash would make the surviving copy unindexable forever: each
// scan would collide with it, fail to verify (sameContent reads the file the row
// points at — now absent — and answers null = "unverifiable"), skip the file and
// re-record the very duplicate hit we just resolved.
//
// No-op if the asset was restored in the meantime: a row back in the library
// keeps its hash and its derivatives, exactly like the purge worker's re-check.
async function reclaimTrashedAsset(assetId: number): Promise<void> {
  const a = await one<{
    id: number;
    abs_path: string;
    file_size: string | number | null;
    thumb_key: string | null;
    proxy_key: string | null;
    purged: boolean;
  }>(
    `SELECT id, abs_path, file_size, thumb_key, proxy_key,
            (purged_at IS NOT NULL) AS purged
       FROM assets
      WHERE id = $1 AND deleted_at IS NOT NULL`,
    [assetId],
  );
  if (!a) return;

  const storage = await getStorage();
  for (const key of [a.thumb_key, a.proxy_key])
    if (key) await storage.del(key).catch(() => {});

  await q(
    `UPDATE assets
        SET purged_at = COALESCE(purged_at, now()), purge_error = NULL,
            content_hash = NULL,
            thumb_key = NULL, proxy_key = NULL,
            derivative_status = 'skipped', updated_at = now()
      WHERE id = $1 AND deleted_at IS NOT NULL`,
    [a.id],
  );
  // Already-purged rows are only here to release their hash — they were logged
  // when their bytes actually went.
  if (!a.purged)
    await q(
      `INSERT INTO purge_log (asset_id, abs_path, file_size, status, error)
       VALUES ($1, $2, $3, 'purged', $4)`,
      [
        a.id,
        a.abs_path,
        a.file_size,
        "reclaimed while resolving a duplicate group",
      ],
    );
}

export type DeleteDuplicatesResult = {
  deleted: string[];
  skipped: { path: string; reason: string }[];
};

// Hard-deletes the extra copies recorded in `duplicate_hits` (NOT a soft delete:
// these files were never indexed, so there is no asset row to hide — the file on
// disk is the only thing to remove). Four layers of safety, in order:
//   1. whitelist  — a path must be a recorded duplicate hit (no arbitrary path),
//   2. asset guard — never touch a path that is a live indexed asset (a kept
//      original or a recovered false collision: distinct content, must survive),
//   3. view-only  — never touch a Final/Export volume (cf. VIEW_ONLY_REASON),
//   4. containment — the path must sit inside the browsable area (incoming/NAS).
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
  // A path can also belong to a TRASHED asset (the guard above only shields the
  // LIVE library). Removing its bytes is legitimate — it's already in the
  // recycle bin — but the row has to be stamped afterwards, or it would keep
  // claiming a file we deleted (and keep holding the content_hash).
  const trashed = new Map(
    (
      await many<{ id: number; abs_path: string }>(
        "SELECT id, abs_path FROM assets WHERE abs_path = ANY($1::text[]) AND deleted_at IS NOT NULL",
        [paths],
      )
    ).map((r) => [r.abs_path, r.id] as const),
  );

  const viewOnly = await viewOnlyRoots();

  const toDelete: string[] = [];
  for (const p of paths) {
    if (!recorded.has(p))
      result.skipped.push({ path: p, reason: "not a recorded duplicate" });
    else if (indexed.has(p))
      result.skipped.push({
        path: p,
        reason: "indexed in the library (kept) — not deleted",
      });
    else if (isUnder(p, viewOnly))
      result.skipped.push({ path: p, reason: VIEW_ONLY_REASON });
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

  for (const p of result.deleted) {
    const id = trashed.get(p);
    if (id != null) await reclaimTrashedAsset(id);
  }

  if (result.deleted.length > 0) {
    await q("DELETE FROM duplicate_hits WHERE abs_path = ANY($1::text[])", [
      result.deleted,
    ]);
  }
  return result;
}

export type KeepOneResult = {
  kept: string;
  deleted: string[];
  relinked: boolean;
  // True when the group's library copy was already in the trash and got
  // RECLAIMED instead of relinked (bytes removed, row stamped purged).
  purged: boolean;
  skipped: { path: string; reason: string }[];
};

// Resolve a group of byte-identical copies down to the SINGLE survivor the user
// picked. This is the one operation allowed to drop the library-indexed copy:
// deleteDuplicateFiles refuses to touch a live asset (it only ever clears the
// non-indexed extras), but here the user has explicitly decided which copy to
// keep — the library no longer assumes its own copy is the keeper.
//
//   - keep the indexed copy  → just delete the recorded on-disk duplicates,
//   - keep an on-disk copy    → RELINK the asset row onto it first (its id,
//     rating, tags and derivatives all stay valid — the bytes are identical),
//     THEN delete the former original and every other copy.
//
// The library copy counts as a group member whether it is live, TRASHED or
// already purged. Scoping it to the live library used to make a group with a
// soft-deleted copy unresolvable: picking that copy was rejected ("not part of
// this duplicate group") and picking any other one silently collapsed the group
// to a single member — reporting success, deleting nothing, and clearing the
// audit row that was the only trace of the leftover file.
//
// A TRASHED library copy is never relinked, though: the user already culled that
// media, and pointing a trashed (hence purgeable) row at the survivor would put
// the file they just chose to keep one purge away from deletion. It is reclaimed
// instead — same contract as the purge worker, cf. reclaimTrashedAsset.
//
// A copy on a VIEW-ONLY volume can never be a loser. When it's the library copy
// the whole call is refused up front — accepting it would relink the entry off
// the final master and then fail to unlink it, leaving the very file we must not
// touch orphaned on disk. An on-disk copy there is merely skipped, like one
// outside the browsable area. Either way the final survives; keep IT and the
// cullable extras are the ones that go.
//
// Only verified-identical / unverifiable copies are eligible — a FALSE collision
// (distinct content sharing a partial hash) is stored with a NULL content_hash
// and is never pulled in here, so genuinely different shots can't be collapsed.
// Relink happens before any unlink, so a mid-way failure can never leave the
// asset pointing at a file we already removed.
export async function keepOneCopy(args: {
  contentHash: string;
  keepPath: string;
}): Promise<KeepOneResult> {
  const { contentHash, keepPath } = args;
  const result: KeepOneResult = {
    kept: keepPath,
    deleted: [],
    relinked: false,
    purged: false,
    skipped: [],
  };

  // The indexed asset holding this content (the current "original"), trashed and
  // purged rows included. content_hash is UNIQUE (migration 0001) so there is at
  // most one; a recovered false collision has content_hash = NULL and can never
  // match here.
  const asset = await one<{
    id: number;
    abs_path: string;
    trashed: boolean;
    purged: boolean;
  }>(
    `SELECT id, abs_path,
            (deleted_at IS NOT NULL) AS trashed,
            (purged_at  IS NOT NULL) AS purged
       FROM assets
      WHERE content_hash = $1`,
    [contentHash],
  );
  // Every recorded on-disk copy of this content (never a false collision).
  const copies = (
    await many<{ abs_path: string }>(
      "SELECT abs_path FROM duplicate_hits WHERE content_hash = $1 AND verified IS NOT FALSE",
      [contentHash],
    )
  ).map((r) => r.abs_path);

  const members = new Set<string>(copies);
  // A purged row has no bytes left, so it isn't a copy the user can keep — it
  // only still holds the hash, which the reclaim below releases.
  if (asset && !asset.purged) members.add(asset.abs_path);
  if (!members.has(keepPath))
    throw new DuplicateError("The copy to keep is not part of this duplicate group.");

  // The library copy, when it is one of the losers.
  const libraryLoser = asset && asset.abs_path !== keepPath ? asset : null;

  const viewOnly = await viewOnlyRoots();
  // Refuse before touching anything: the library copy is a finalized master, so
  // there is no way to honour "keep only this other copy" — the master stays.
  if (libraryLoser && isUnder(libraryLoser.abs_path, viewOnly))
    throw new DuplicateError(
      "The library copy sits on a view-only volume (Final/Export) and is never deleted. Keep that copy instead — the extra copies are the ones deduplication removes.",
    );

  // Relink the asset onto the survivor up front, when the user keeps an on-disk
  // copy rather than a LIVE indexed original.
  if (libraryLoser && !libraryLoser.trashed) {
    if (!isWithinBrowseRoots(keepPath))
      throw new DuplicateError("The copy to keep is outside the allowed area.");
    // abs_path is UNIQUE: refuse if the survivor is somehow already indexed.
    const occupied = await one<{ id: number }>(
      "SELECT id FROM assets WHERE abs_path = $1 AND deleted_at IS NULL AND id <> $2",
      [keepPath, libraryLoser.id],
    );
    if (occupied)
      throw new DuplicateError("The copy to keep is already indexed as another asset.");
    await q("UPDATE assets SET abs_path = $1, updated_at = now() WHERE id = $2", [
      keepPath,
      libraryLoser.id,
    ]);
    result.relinked = true;
  }

  // Delete every member except the survivor (the former original included — the
  // asset already points elsewhere). Containment is re-checked per path.
  for (const p of members) {
    if (p === keepPath) continue;
    if (isUnder(p, viewOnly)) {
      result.skipped.push({ path: p, reason: VIEW_ONLY_REASON });
      continue;
    }
    if (!isWithinBrowseRoots(p)) {
      result.skipped.push({ path: p, reason: "outside the allowed area" });
      continue;
    }
    try {
      await rm(p, { force: true });
      result.deleted.push(p);
    } catch (err) {
      result.skipped.push({ path: p, reason: (err as Error).message });
    }
  }

  // Stamp the trashed library copy once its bytes are actually gone (an
  // already-purged row is reclaimed unconditionally: only its hash is left to
  // release). Ordered like the purge worker — unlink, then stamp — so a blocked
  // removal leaves a retryable row rather than a row claiming a file it kept.
  if (libraryLoser && libraryLoser.trashed) {
    if (libraryLoser.purged || result.deleted.includes(libraryLoser.abs_path)) {
      await reclaimTrashedAsset(libraryLoser.id);
      result.purged = true;
    }
  }

  // Clear the audit rows we've resolved: the survivor (no longer a pending
  // duplicate) and everything we actually deleted. A copy we had to skip keeps
  // its row so it stays visible for a retry.
  await q("DELETE FROM duplicate_hits WHERE abs_path = ANY($1::text[])", [
    [keepPath, ...result.deleted],
  ]);

  return result;
}

export type DiscardCopyResult = {
  assetId: number;
  path: string;
  // false when there was nothing left to unlink (row already purged).
  deleted: boolean;
  // true when this was the group's last extra copy and the audit rows went too.
  resolved: boolean;
};

// Remove the FILE of a duplicate group's library copy, for the one case where
// that is unambiguous: the copy is already in the trash. "Keep only this" can
// only express "collapse the whole group onto one survivor"; when several extra
// copies are still under triage, this drops just the trashed one and leaves the
// rest listed.
//
// A LIVE library copy is deliberately refused — removing it would leave an
// indexed asset pointing at nothing. That case has to go through keepOneCopy,
// which relinks the row onto the survivor first.
//
// Safety mirrors deleteDuplicateFiles: the asset must be part of a RECORDED
// duplicate group (so another copy of these bytes is known to exist — this can
// never be the last one), it must be in the trash, it must not sit on a
// view-only Final/Export volume (being in the trash does not make a finalized
// master deletable — the purge worker refuses it too), and its path must sit
// inside the browsable area.
export async function discardTrashedCopy(
  assetId: number,
): Promise<DiscardCopyResult> {
  const asset = await one<{
    id: number;
    abs_path: string;
    content_hash: string | null;
    trashed: boolean;
    purged: boolean;
  }>(
    `SELECT id, abs_path, content_hash,
            (deleted_at IS NOT NULL) AS trashed,
            (purged_at  IS NOT NULL) AS purged
       FROM assets
      WHERE id = $1`,
    [assetId],
  );
  if (!asset) throw new DuplicateError("That asset no longer exists.");
  if (!asset.trashed)
    throw new DuplicateError(
      'That copy is still in the library. Use "Keep only this" on the copy you want to survive, so the library entry follows it.',
    );
  if (!asset.content_hash)
    throw new DuplicateError("That copy is not part of a duplicate group.");

  const otherCopies = (
    await many<{ abs_path: string }>(
      `SELECT abs_path FROM duplicate_hits
        WHERE content_hash = $1 AND verified IS NOT FALSE AND abs_path <> $2`,
      [asset.content_hash, asset.abs_path],
    )
  ).map((r) => r.abs_path);
  if (otherCopies.length === 0)
    throw new DuplicateError(
      "No other copy of this content is recorded — refusing to remove the only one left.",
    );

  if (isUnder(asset.abs_path, await viewOnlyRoots()))
    throw new DuplicateError(
      "That copy sits on a view-only volume (Final/Export) and is never deleted, trash or not.",
    );
  if (!isWithinBrowseRoots(asset.abs_path))
    throw new DuplicateError("That copy is outside the allowed area.");

  let deleted = false;
  if (!asset.purged) {
    await rm(asset.abs_path, { force: true });
    deleted = true;
  }
  await reclaimTrashedAsset(asset.id);

  // With the library copy gone, a lone remaining file is no longer a duplicate
  // of anything — the released hash lets the next scan index it normally, so the
  // audit row has nothing left to report. Two or more still shadow each other
  // and stay listed for triage.
  const resolved = otherCopies.length === 1;
  if (resolved)
    await q("DELETE FROM duplicate_hits WHERE abs_path = ANY($1::text[])", [
      otherCopies,
    ]);

  return { assetId: asset.id, path: asset.abs_path, deleted, resolved };
}

// Only ENOENT means "gone" — mirrors fileExists in lib/integrity.ts. Any other
// error (permissions, a flaky/unmounted volume) must never make a row vanish.
async function fileGone(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export type PurgeResolvedResult = { checked: number; purged: number };

// Every duplicate_hits row was recorded against a file that existed on disk at
// scan time. "Delete"/"Keep only this"/"Discard" above all clear their own rows
// as they act — but nothing clears a row when its file is removed OUTSIDE the
// app (by hand, e.g. straight from the incoming folder rather than through this
// page): the row is left claiming a copy that is already gone, forever, since
// nothing ever re-visits it. This re-stats every recorded path and drops the
// rows confirmed gone. No file is touched — there is nothing left to delete —
// only the stale audit row goes.
export async function purgeResolvedDuplicateHits(): Promise<PurgeResolvedResult> {
  const rows = await many<{ abs_path: string }>(
    "SELECT abs_path FROM duplicate_hits",
  );
  const gone: string[] = [];
  for (const r of rows) {
    if (await fileGone(r.abs_path)) gone.push(r.abs_path);
  }
  if (gone.length > 0)
    await q("DELETE FROM duplicate_hits WHERE abs_path = ANY($1::text[])", [
      gone,
    ]);
  return { checked: rows.length, purged: gone.length };
}
