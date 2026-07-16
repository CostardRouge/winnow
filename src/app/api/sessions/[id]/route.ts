// GET    /api/sessions/:id -> one session + its root (kind/path) + the full
//    status breakdown (ready/pending/error derivatives, pick/reject/skip/unrated
//    verdicts) and the computed lifecycle `status` (empty/to_sort/done). Feeds
//    the session detail page header.
// PATCH  /api/sessions/:id { ignored } -> updates the folder.
//  - ignored : the lone manual flag — "skip this whole session". Cascades
//    processing_state=ignored and stops derivatives (§5). Inverse: resets to
//    `unprocessed` and re-enqueues the missing ones. (Whether a session is
//    "done" is computed from its verdicts, never hand-set.)
// DELETE /api/sessions/:id[?files=true] -> removes the session entirely.
//  - always: drops the DB row (cascade: assets/ratings/tags/exports) + the
//    derivative cache (thumb/proxy) — neither of which is an original.
//  - files=true: ALSO deletes the original files from disk (irreversible). Only
//    allowed for the cullable Incoming zone (source/inbox); the Final archive and
//    Export volumes are view-only and never touched. Every removal is confined to
//    the session folder. Lets you clear an orphaned import that was never cleaned.
import { NextRequest } from "next/server";
import { z } from "zod";
import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { many, one, q } from "@/lib/db";
import { enqueueDerivative } from "@/lib/queue";
import { getStorage } from "@/lib/storage/index";
import { json, badRequest, notFound, serverError } from "@/lib/api";
import type { Root, Session } from "@/lib/types";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    if (!Number.isFinite(sessionId)) return badRequest("Invalid id");

    // One session enriched with its root (kind drives which actions are legal,
    // path shows where it lives) and the same counters the list view computes,
    // plus the verdict breakdown the detail header surfaces. Counts exclude
    // soft-deleted assets so they match the grid.
    const session = await one(
      `SELECT
         s.*,
         rt.kind AS root_kind,
         rt.path AS root_path,
         COALESCE(d.ready, 0)    AS ready_count,
         COALESCE(d.pending, 0)  AS pending_count,
         COALESCE(d.error, 0)    AS error_count,
         COALESCE(d.live, 0)     AS live_count,
         COALESCE(d.picks, 0)    AS pick_count,
         COALESCE(d.rejects, 0)  AS reject_count,
         COALESCE(d.skips, 0)    AS skip_count,
         COALESCE(d.unrated, 0)  AS unrated_count,
         -- Computed lifecycle: empty (no live media) · done (every media has a
         -- verdict) · to_sort (some still unrated). Orthogonal to s.ignored.
         CASE
           WHEN COALESCE(d.live, 0) = 0     THEN 'empty'
           WHEN COALESCE(d.unrated, 0) = 0  THEN 'done'
           ELSE 'to_sort'
         END AS status,
         -- Companion pairs present in the session (drives the export modal's
         -- RAW+JPEG / Live Photo options).
         COALESCE(g.raw_jpeg_pairs, 0)   AS raw_jpeg_pairs,
         COALESCE(g.live_photo_pairs, 0) AS live_photo_pairs
       FROM sessions s
       JOIN roots rt ON rt.id = s.root_id
       LEFT JOIN (
         SELECT
           a.session_id,
           count(*)                                                                  AS live,
           count(*) FILTER (WHERE a.derivative_status = 'ready')                      AS ready,
           count(*) FILTER (WHERE a.derivative_status IN ('pending','processing'))    AS pending,
           count(*) FILTER (WHERE a.derivative_status = 'error')                      AS error,
           count(*) FILTER (WHERE r.verdict = 'pick')                                 AS picks,
           count(*) FILTER (WHERE r.verdict = 'reject')                               AS rejects,
           count(*) FILTER (WHERE r.verdict = 'skip')                                 AS skips,
           count(*) FILTER (WHERE r.verdict IS NULL OR r.verdict = 'unrated')         AS unrated
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         WHERE a.deleted_at IS NULL
         GROUP BY a.session_id
       ) d ON d.session_id = s.id
       LEFT JOIN (
         SELECT session_id,
                count(*) FILTER (WHERE kind = 'raw_jpeg')   AS raw_jpeg_pairs,
                count(*) FILTER (WHERE kind = 'live_photo')  AS live_photo_pairs
         FROM asset_groups
         GROUP BY session_id
       ) g ON g.session_id = s.id
       WHERE s.id = $1`,
      [sessionId],
    );
    if (!session) return notFound("Session not found");
    return json({ session });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  ignored: z.boolean(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ignored required");
    const { ignored } = parsed.data;

    const session = await one<Session>(
      "UPDATE sessions SET ignored = $2 WHERE id = $1 RETURNING *",
      [sessionId, ignored],
    );
    if (!session) return notFound("Session not found");

    if (ignored) {
      // Cascade: everything goes to ignored; we cut off the pending derivatives.
      await q(
        `UPDATE assets
           SET processing_state = 'ignored',
               derivative_status = CASE
                 WHEN derivative_status IN ('pending','processing') THEN 'skipped'
                 ELSE derivative_status END,
               updated_at = now()
         WHERE session_id = $1`,
        [sessionId],
      );
    } else {
      // Reactivation: we switch back to unprocessed and regenerate the missing
      // derivatives (photos and videos alike).
      await q(
        `UPDATE assets
           SET processing_state = 'unprocessed', updated_at = now()
         WHERE session_id = $1 AND processing_state = 'ignored'`,
        [sessionId],
      );
      const toDerive = await many<{ id: number }>(
        `UPDATE assets
           SET derivative_status = 'pending', updated_at = now()
         WHERE session_id = $1
           AND derivative_status IN ('skipped','error')
         RETURNING id`,
        [sessionId],
      );
      for (const a of toDerive) await enqueueDerivative(a.id);
    }

    return json({ session });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    if (!Number.isFinite(sessionId)) return badRequest("Invalid id");

    // `?files=true` also wipes the originals from disk (irreversible); otherwise
    // only the DB records + the derivative cache (both ours) are cleared.
    const deleteFiles = req.nextUrl.searchParams.get("files") === "true";

    // Capture the session, its root kind (which gates the filesystem delete) and
    // the full asset list (paths + derivative keys) BEFORE the cascade drops them.
    const session = await one<Session & { root_kind: Root["kind"] }>(
      `SELECT s.*, rt.kind AS root_kind
         FROM sessions s
         JOIN roots rt ON rt.id = s.root_id
        WHERE s.id = $1`,
      [sessionId],
    );
    if (!session) return notFound("Session not found");

    const assets = await many<{
      abs_path: string;
      thumb_key: string | null;
      proxy_key: string | null;
    }>(
      "SELECT abs_path, thumb_key, proxy_key FROM assets WHERE session_id = $1",
      [sessionId],
    );

    // Sony video sidecars (XML/THM) sit on disk next to their clip; the DB rows
    // cascade-drop with the assets below, but their FILES must be removed too
    // when files=true. Loaded up front, before the cascade clears them.
    const sidecars = deleteFiles
      ? await many<{ abs_path: string }>(
          `SELECT sc.abs_path
             FROM asset_sidecars sc
             JOIN assets a ON a.id = sc.asset_id
            WHERE a.session_id = $1`,
          [sessionId],
        )
      : [];

    let filesDeleted = 0;
    let folderRemoved = false;
    const fileErrors: string[] = [];

    if (deleteFiles) {
      // Guard: only the cullable Incoming zone (source/inbox) may lose its
      // originals. The Final archive (Immich output) and Export volumes are
      // view-only — refuse rather than ever touch them.
      if (session.root_kind !== "source" && session.root_kind !== "inbox") {
        return badRequest(
          "Filesystem deletion is only allowed for incoming sessions",
        );
      }
      // Confine every removal to the session folder: resolve each path and make
      // sure it sits under source_path before unlinking, so a stray abs_path can
      // never delete anything outside the session.
      const base = path.resolve(session.source_path);
      for (const a of assets) {
        const target = path.resolve(a.abs_path);
        if (target !== base && !target.startsWith(base + path.sep)) {
          fileErrors.push(`skipped (outside session folder): ${a.abs_path}`);
          continue;
        }
        try {
          await rm(target, { force: true });
          filesDeleted++;
        } catch (err) {
          fileErrors.push(`${a.abs_path}: ${(err as Error).message}`);
        }
      }
      // Same treatment for the clips' sidecars — confined to the session folder.
      for (const sc of sidecars) {
        const target = path.resolve(sc.abs_path);
        if (target !== base && !target.startsWith(base + path.sep)) {
          fileErrors.push(`skipped (outside session folder): ${sc.abs_path}`);
          continue;
        }
        try {
          await rm(target, { force: true });
          filesDeleted++;
        } catch (err) {
          fileErrors.push(`${sc.abs_path}: ${(err as Error).message}`);
        }
      }
      // Drop the now-empty session folder. Non-recursive: rmdir only succeeds on
      // an empty directory, so it can never wipe a populated tree.
      try {
        await rmdir(base);
        folderRemoved = true;
      } catch {
        /* not empty / not removable: leave the folder in place */
      }
    }

    // Clear the derivative cache (thumb + proxy) in every case — these are ours,
    // never the originals, so they are always safe to drop.
    const storage = await getStorage();
    let derivativesDeleted = 0;
    for (const a of assets) {
      for (const key of [a.thumb_key, a.proxy_key]) {
        if (!key) continue;
        try {
          await storage.del(key);
          derivativesDeleted++;
        } catch {
          /* best-effort cache cleanup */
        }
      }
    }

    // Finally drop the row — ON DELETE CASCADE clears assets/ratings/tags/exports.
    await q("DELETE FROM sessions WHERE id = $1", [sessionId]);

    return json({
      deleted: {
        session_id: sessionId,
        assets: assets.length,
        files_deleted: filesDeleted,
        folder_removed: folderRemoved,
        derivatives_deleted: derivativesDeleted,
        file_errors: fileErrors,
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
