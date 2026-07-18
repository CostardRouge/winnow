// Purge worker — the reclaiming half of the "winnowing".
//
// Soft-delete (lib/assetActions deleteAssets) is the recycle bin: it only sets
// `deleted_at`, so the NAS original is untouched and the space is still used.
// A purge is the deliberate second stage: for the trashed selection it
// physically removes the original AND its cached derivatives, then stamps
// `purged_at`. Bounded concurrency (config.purgeConcurrency) spares the NAS HDD.
//
// Safety (mirrors the guards on DELETE /api/sessions/:id?files=true):
//   - operates ONLY on already soft-deleted assets (deleted:"trash"), never on
//     the live library;
//   - only the cullable Incoming zone (root kind source/inbox) may lose its
//     originals — Final (Immich) and Export volumes are view-only and refused;
//   - every removal is confined to its session folder (resolved abs_path must
//     sit under source_path), so a stray path can't delete anything outside it;
//   - re-checks the trash state immediately before unlinking, so an asset the
//     user restored *while the job runs* is left untouched;
//   - `unlink` of a missing file (ENOENT) is treated as success (idempotent);
//   - any blocked/failed file (read-only mount, view-only volume, perms…) is
//     recorded in `purge_error` + `purge_log`; the asset KEEPS its `deleted_at`
//     (stays in the trash, retryable) and its derivatives are left intact;
//   - the asset row itself is never deleted (audit + export lineage): `purged_at`
//     marks the bytes as gone while `deleted_at` keeps it hidden.
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { q, one, many } from "./db";
import { FilterSchema, buildFilter } from "./filter";
import { getStorage } from "./storage";
import type { Asset } from "./types";

type PurgeError = { asset_id: number; abs_path: string; error: string };

// Roots whose originals may be removed. Finals (Immich output) and Export
// volumes are view-only — refuse rather than ever touch them.
const PURGEABLE_KINDS = new Set(["source", "inbox"]);

// Cap the inline error list kept in the job result (the full record lives in
// purge_log) so a pathological run can't bloat the JSONB row.
const MAX_INLINE_ERRORS = 50;

type Row = Asset & { root_kind: string; source_path: string };

export async function runPurgeJob(purgeJobId: number): Promise<void> {
  const job = await one<{ id: number; filter_query: unknown }>(
    "SELECT id, filter_query FROM purge_jobs WHERE id = $1",
    [purgeJobId],
  );
  if (!job) throw new Error(`purge_job not found: ${purgeJobId}`);

  await q("UPDATE purge_jobs SET status='running' WHERE id=$1", [purgeJobId]);

  try {
    // Resolve the saved selection — always re-scoped to the trash, so a stale
    // filter can never reach a live (non-deleted) asset. Join the root so we can
    // gate by kind and confine to the session folder.
    const filter = FilterSchema.parse(job.filter_query ?? {});
    const { conditions, params } = buildFilter(filter, 1, { deleted: "trash" });
    const where = `WHERE ${conditions.join(" AND ")}`;

    const assets = await many<Row>(
      `SELECT a.*, rt.kind AS root_kind, s.source_path
         FROM assets a
         JOIN sessions s ON s.id = a.session_id
         JOIN roots rt ON rt.id = s.root_id
         LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
       ORDER BY a.id`,
      params,
    );

    const storage = await getStorage();
    let purged = 0;
    let freedBytes = 0;
    let skipped = 0; // restored/already-gone-from-trash mid-job (silent)
    let errorCount = 0;
    const errors: PurgeError[] = [];

    const fail = async (asset: Row, message: string) => {
      // Blocked or failed: leave it in the trash, record why, keep its
      // derivatives so it stays viewable/restorable. Retryable.
      await q(
        "UPDATE assets SET purge_error = $2, updated_at = now() WHERE id = $1",
        [asset.id, message],
      );
      await q(
        `INSERT INTO purge_log (asset_id, abs_path, file_size, status, error)
         VALUES ($1, $2, $3, 'error', $4)`,
        [asset.id, asset.abs_path, asset.file_size, message],
      );
      errorCount++;
      if (errors.length < MAX_INLINE_ERRORS)
        errors.push({ asset_id: asset.id, abs_path: asset.abs_path, error: message });
    };

    for (const asset of assets) {
      // Guard 1 — only the cullable Incoming zone may lose originals. The one
      // exception: an original already GONE from disk, re-verified as absent
      // right here, has no bytes to lose — purging it only clears the cached
      // derivatives and stamps the row, which is safe on ANY volume. This is
      // what lets the user reclaim an orphaned Final asset (its file removed by
      // hand, a junk/@eaDir entry) that would otherwise be stuck forever, while
      // a Final original that still EXISTS is refused exactly as before.
      let unlinkOriginal = true;
      if (!PURGEABLE_KINDS.has(asset.root_kind)) {
        const absent = await stat(asset.abs_path).then(
          () => false,
          (err) => (err as NodeJS.ErrnoException).code === "ENOENT",
        );
        if (!absent) {
          await fail(asset, `refused: ${asset.root_kind} volume is view-only`);
          continue;
        }
        unlinkOriginal = false;
      }

      // Guard 2 — confine the removal to the session folder. A resolved path
      // that escapes source_path is never touched.
      const base = path.resolve(asset.source_path);
      const target = path.resolve(asset.abs_path);
      if (target !== base && !target.startsWith(base + path.sep)) {
        await fail(asset, `refused: path escapes the session folder`);
        continue;
      }

      // Guard 3 — re-check the trash state right before the irreversible step.
      // If the user restored (or another job already purged) this asset while we
      // were running, skip it silently rather than delete what they kept.
      const still = await one<{ deleted_at: string | null; purged_at: string | null }>(
        "SELECT deleted_at, purged_at FROM assets WHERE id = $1",
        [asset.id],
      );
      if (!still || still.deleted_at == null || still.purged_at != null) {
        skipped++;
        continue;
      }

      try {
        // 1) Remove the original (the point: reclaim NAS space). A file that is
        //    already gone counts as reclaimed. Skipped on the view-only-missing
        //    path (nothing on disk, and the volume must never be written).
        if (unlinkOriginal) {
          try {
            await unlink(target);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }

        // 1b) Remove the clip's Sony sidecars (XML/THM) — they travel with the
        //     video, so reclaiming the clip reclaims them too. Confined to the
        //     same session folder, idempotent on ENOENT, then their rows go.
        //     Skipped with the original on view-only volumes: their files (if
        //     any survive) are never touched there.
        if (unlinkOriginal) {
          const sidecars = await many<{
            id: number;
            abs_path: string;
            file_size: string | number | null;
          }>(
            "SELECT id, abs_path, file_size FROM asset_sidecars WHERE asset_id = $1",
            [asset.id],
          );
          for (const sc of sidecars) {
            const scTarget = path.resolve(sc.abs_path);
            if (scTarget !== base && !scTarget.startsWith(base + path.sep)) continue;
            try {
              await unlink(scTarget);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            }
            freedBytes += Number(sc.file_size ?? 0);
          }
          if (sidecars.length)
            await q("DELETE FROM asset_sidecars WHERE asset_id = $1", [asset.id]);
        }

        // 2) Remove the cached derivatives (thumb + proxy). These live on the
        //    Optiplex cache, so freeing them is best-effort and never blocking.
        for (const key of [asset.thumb_key, asset.proxy_key]) {
          if (key) await storage.del(key).catch(() => {});
        }

        // 3) Stamp the row: bytes gone, derivatives gone, still hidden. Guarded
        //    on the trash state so a concurrent restore wins the race cleanly.
        const stamped = await one<{ id: number }>(
          `UPDATE assets
              SET purged_at = now(), purge_error = NULL,
                  thumb_key = NULL, proxy_key = NULL,
                  derivative_status = 'skipped', updated_at = now()
            WHERE id = $1 AND deleted_at IS NOT NULL AND purged_at IS NULL
          RETURNING id`,
          [asset.id],
        );
        if (!stamped) {
          // Restored in the tiny window after the re-check: the file is gone but
          // the user un-trashed it. Record it so the state is explained.
          await q(
            `INSERT INTO purge_log (asset_id, abs_path, file_size, status, error)
             VALUES ($1, $2, $3, 'purged', 'restored mid-purge; file already removed')`,
            [asset.id, asset.abs_path, asset.file_size],
          );
          skipped++;
          continue;
        }
        await q(
          `INSERT INTO purge_log (asset_id, abs_path, file_size, status)
           VALUES ($1, $2, $3, 'purged')`,
          [asset.id, asset.abs_path, asset.file_size],
        );
        purged++;
        freedBytes += Number(asset.file_size ?? 0);
      } catch (err) {
        await fail(asset, (err as Error).message);
      }
    }

    await q(
      `UPDATE purge_jobs SET status='done', finished_at=now(), result=$2 WHERE id=$1`,
      [
        purgeJobId,
        JSON.stringify({
          total: assets.length,
          purged,
          freed_bytes: freedBytes,
          skipped,
          error_count: errorCount,
          errors,
        }),
      ],
    );
  } catch (err) {
    await q(
      `UPDATE purge_jobs SET status='error', finished_at=now(), result=$2 WHERE id=$1`,
      [purgeJobId, JSON.stringify({ error: (err as Error).message })],
    );
    throw err;
  }
}
