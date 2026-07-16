// File integrity — the missing half of the indexer.
//
// The incremental scan (lib/indexer.ts) is driven by the files that EXIST on
// disk, so it can only ever add or update: an original deleted from the NAS
// (or an empty file cleaned up by hand) left its asset row behind forever —
// still in the gallery and its session, with a derivative that can never be
// rebuilt. Two entry points close that gap:
//
//   - reconcileMissingForRoot : runs at the end of every COMPLETE scan. The
//     walk records each media path it visits; any live asset of the root the
//     walk did not see is re-stat-ed individually and, if truly gone (ENOENT),
//     marked missing + auto-trashed (reversible soft delete). Assets already
//     flagged missing whose file is back are restored.
//   - runIntegrityJob : the on-demand sweep (integrity queue). Re-stats every
//     live original AND checks the derivative objects (thumb/proxy) still
//     exist in storage — a missing derivative with a healthy source is simply
//     re-enqueued for generation; a missing source funnels into the same
//     missing pipeline as the scan-time detector.
//
// Safety first — this module decides that files "no longer exist", so every
// verdict is individually confirmed and mass events are never trusted:
//   - a candidate is only marked after its OWN fs.stat fails with ENOENT
//     (EACCES/EIO/timeout → skipped: unreachable is not deleted);
//   - if the root path itself is gone/unreadable (unmounted NAS), the pass is
//     skipped entirely;
//   - if "too many" originals vanish at once (an unmounted subtree looks like
//     a mass delete), the assets are FLAGGED missing but NOT auto-trashed —
//     they stay visible, listed for manual triage instead;
//   - the auto-trash is the ordinary reversible soft delete. Restore happens
//     automatically when the file reappears, or by hand from the triage page.
//     Purging (irreversible) is always a separate, confirmed user action.
import { stat } from "node:fs/promises";
import { q, one, many } from "./db";
import { enqueueDerivative } from "./queue";
import { getStorage } from "./storage";
import { getSettings } from "./settings";
import type { Root } from "./types";

// Mass-disappearance guard: auto-trash only when the confirmed-missing set is
// small in absolute terms OR a small share of the root's live assets. Beyond
// that, flag without trashing — an unmounted/renamed folder must never empty
// the library on its own.
const MASS_MISSING_MIN = 100; // always auto-trash up to this many
const MASS_MISSING_RATIO = 0.2; // above the min, trash only if < 20% vanished

export type MissingReport = {
  // Candidates re-stat-ed (assets of the root the walk did not visit).
  checked: number;
  // Confirmed gone + auto-trashed (reversible).
  trashed: number;
  // Confirmed gone but only flagged (mass-disappearance guard tripped).
  flagged: number;
  // Previously-missing assets whose file is back: flag (and auto-trash) lifted.
  restored: number;
};

const EMPTY_REPORT: MissingReport = {
  checked: 0,
  trashed: 0,
  flagged: 0,
  restored: 0,
};

async function fileExists(absPath: string): Promise<boolean | null> {
  try {
    await stat(absPath);
    return true;
  } catch (err) {
    // Only ENOENT means "deleted". Anything else (permissions, I/O error, a
    // flaky mount) is "unknown" — never a reason to declare a file gone.
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
}

// Marks a confirmed-missing set: flag every id, auto-trash unless the guard
// tripped. One statement so missing_at and deleted_at share the same
// timestamp — that equality is what later identifies OUR auto-trash (vs a
// user's manual delete) when the file reappears and the trash must be lifted.
async function markMissing(
  ids: number[],
  opts: { autoTrash: boolean },
): Promise<void> {
  if (!ids.length) return;
  if (opts.autoTrash) {
    await q(
      `UPDATE assets
          SET missing_at = now(),
              deleted_at = COALESCE(deleted_at, now()),
              updated_at = now()
        WHERE id = ANY($1) AND missing_at IS NULL`,
      [ids],
    );
  } else {
    await q(
      `UPDATE assets
          SET missing_at = now(), updated_at = now()
        WHERE id = ANY($1) AND missing_at IS NULL`,
      [ids],
    );
  }
}

// Lifts the missing flag on assets whose file is back. The auto-trash is
// lifted with it (deleted_at = missing_at ⇒ we set it), while a user's own
// soft-delete (different timestamp) is respected and kept.
export async function restoreMissing(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await q(
    `UPDATE assets
        SET deleted_at = CASE WHEN deleted_at = missing_at THEN NULL ELSE deleted_at END,
            missing_at = NULL,
            updated_at = now()
      WHERE id = ANY($1) AND missing_at IS NOT NULL`,
    [ids],
  );
  return res.rowCount ?? 0;
}

// End-of-scan reconciliation. `visited` is the set of abs_paths the walk
// classified as media (recorded BEFORE any per-file processing, so a file that
// merely failed indexing is never mistaken for a deleted one — and each
// candidate is re-stat-ed anyway). Call only after a COMPLETE walk: a stopped
// (paused/preempted) scan has not seen everything it should have.
export async function reconcileMissingForRoot(
  root: Root,
  visited: ReadonlySet<string>,
): Promise<MissingReport> {
  // Guard: if the root itself is unreachable, nothing can be concluded.
  if ((await fileExists(root.path)) !== true) {
    console.warn(
      `[integrity] root ${root.id} unreachable, missing-file pass skipped: ${root.path}`,
    );
    return { ...EMPTY_REPORT };
  }

  const report: MissingReport = { ...EMPTY_REPORT };

  // Reappearance first: previously-missing assets seen by this walk (or whose
  // file answers a stat again) come back — flag lifted, auto-trash undone.
  const missing = await many<{ id: number; abs_path: string }>(
    `SELECT a.id, a.abs_path
       FROM assets a
       JOIN sessions s ON s.id = a.session_id
      WHERE s.root_id = $1 AND a.missing_at IS NOT NULL AND a.purged_at IS NULL`,
    [root.id],
  );
  const backIds: number[] = [];
  for (const m of missing) {
    if (visited.has(m.abs_path) || (await fileExists(m.abs_path)) === true) {
      backIds.push(m.id);
    }
  }
  report.restored = await restoreMissing(backIds);

  // Detection: live assets of this root the walk did not visit. The diff runs
  // in memory (id + path only), then each candidate is confirmed by its own
  // stat — a transient unreadable subfolder in the walk must not condemn its
  // files.
  const live = await many<{ id: number; abs_path: string }>(
    `SELECT a.id, a.abs_path
       FROM assets a
       JOIN sessions s ON s.id = a.session_id
      WHERE s.root_id = $1 AND a.deleted_at IS NULL AND a.purged_at IS NULL`,
    [root.id],
  );
  const gone: number[] = [];
  for (const a of live) {
    if (visited.has(a.abs_path)) continue;
    report.checked++;
    if ((await fileExists(a.abs_path)) === false) gone.push(a.id);
  }

  if (gone.length) {
    const autoTrash =
      gone.length <= MASS_MISSING_MIN ||
      gone.length < live.length * MASS_MISSING_RATIO;
    await markMissing(gone, { autoTrash });
    if (autoTrash) report.trashed = gone.length;
    else {
      report.flagged = gone.length;
      console.warn(
        `[integrity] root ${root.id}: ${gone.length}/${live.length} originals vanished at once — flagged only (mass-disappearance guard), review /pipeline/failures`,
      );
    }
  }
  return report;
}

export type IntegrityReport = {
  // Assets whose source file was re-stat-ed.
  checked: number;
  // Sources confirmed gone: auto-trashed / flagged (guard) — see MissingReport.
  missingTrashed: number;
  missingFlagged: number;
  // 'ready' assets whose thumb/proxy object was gone from storage but whose
  // source is healthy: reset to 'pending' and re-enqueued for generation.
  repaired: number;
  // True if the sweep stopped early because the pipeline was paused.
  stopped: boolean;
};

const BATCH = 500;

// Full integrity sweep (the `integrity` queue's job): re-stats every live
// original and every 'ready' derivative object. Batched by id so the memory
// stays flat on a large library; respects the global pipeline pause between
// batches (a paused NAS should not be hammered with stats).
export async function runIntegrityJob(
  opts: { rootId?: number | null } = {},
): Promise<IntegrityReport> {
  const report: IntegrityReport = {
    checked: 0,
    missingTrashed: 0,
    missingFlagged: 0,
    repaired: 0,
    stopped: false,
  };
  const storage = await getStorage();
  const rootCond = opts.rootId
    ? "AND a.session_id IN (SELECT id FROM sessions WHERE root_id = $2)"
    : "";

  // Unreachable roots are excluded up front — same rationale as the scan-time
  // guard: an unmounted volume proves nothing about its files.
  const roots = await many<Root>(
    opts.rootId
      ? "SELECT * FROM roots WHERE id = $1"
      : "SELECT * FROM roots WHERE kind IN ('source','finals','inbox')",
    opts.rootId ? [opts.rootId] : [],
  );
  const reachable = new Set<number>();
  for (const r of roots) {
    if ((await fileExists(r.path)) === true) reachable.add(r.id);
    else console.warn(`[integrity] root ${r.id} unreachable, skipped: ${r.path}`);
  }
  if (!reachable.size) return report;

  let cursor = 0;
  const gone: number[] = [];
  let liveTotal = 0;
  for (;;) {
    if ((await getSettings()).scanPaused) {
      report.stopped = true;
      break;
    }
    const batch = await many<{
      id: number;
      abs_path: string;
      root_id: number;
      derivative_status: string;
      thumb_key: string | null;
      proxy_key: string | null;
    }>(
      `SELECT a.id, a.abs_path, s.root_id, a.derivative_status,
              a.thumb_key, a.proxy_key
         FROM assets a
         JOIN sessions s ON s.id = a.session_id
        WHERE a.deleted_at IS NULL AND a.purged_at IS NULL AND a.id > $1
          ${rootCond}
        ORDER BY a.id
        LIMIT ${BATCH}`,
      opts.rootId ? [cursor, opts.rootId] : [cursor],
    );
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;

    for (const a of batch) {
      if (!reachable.has(a.root_id)) continue;
      liveTotal++;
      report.checked++;
      const srcExists = await fileExists(a.abs_path);
      if (srcExists === false) {
        gone.push(a.id);
        continue;
      }
      if (srcExists !== true || a.derivative_status !== "ready") continue;

      // Source healthy: verify the derivative objects still exist in storage.
      // A missing thumb/proxy (cache wiped, emptied by hand) is repairable —
      // reset to 'pending' and rebuild from the original.
      let broken = false;
      for (const key of [a.thumb_key, a.proxy_key]) {
        if (key && !(await storage.stat(key))) {
          broken = true;
          break;
        }
      }
      if (broken) {
        await q(
          `UPDATE assets
              SET derivative_status = 'pending', derivative_error = NULL,
                  updated_at = now()
            WHERE id = $1 AND derivative_status = 'ready'`,
          [a.id],
        );
        await enqueueDerivative(a.id);
        report.repaired++;
      }
    }
  }

  if (gone.length && !report.stopped) {
    const autoTrash =
      gone.length <= MASS_MISSING_MIN ||
      gone.length < liveTotal * MASS_MISSING_RATIO;
    await markMissing(gone, { autoTrash });
    if (autoTrash) report.missingTrashed = gone.length;
    else {
      report.missingFlagged = gone.length;
      console.warn(
        `[integrity] sweep: ${gone.length}/${liveTotal} originals vanished at once — flagged only (mass-disappearance guard)`,
      );
    }
  }
  console.log(`[integrity] sweep done`, report);
  return report;
}

// Re-checks a missing selection (triage "Re-check" action): whichever files
// answer a stat again are restored. Returns how many came back.
export async function recheckMissing(ids?: number[]): Promise<number> {
  const rows = ids?.length
    ? await many<{ id: number; abs_path: string }>(
        "SELECT id, abs_path FROM assets WHERE id = ANY($1) AND missing_at IS NOT NULL",
        [ids],
      )
    : await many<{ id: number; abs_path: string }>(
        "SELECT id, abs_path FROM assets WHERE missing_at IS NOT NULL AND purged_at IS NULL",
      );
  const back: number[] = [];
  for (const r of rows) {
    if ((await fileExists(r.abs_path)) === true) back.push(r.id);
  }
  const restored = await restoreMissing(back);
  // A restored asset may have lost its derivative in the meantime (e.g. it was
  // purged-adjacent or errored while missing): re-enqueue the broken ones.
  if (back.length) {
    const rebuild = await many<{ id: number }>(
      `UPDATE assets
          SET derivative_status = 'pending', derivative_error = NULL, updated_at = now()
        WHERE id = ANY($1) AND derivative_status = 'error' AND deleted_at IS NULL
        RETURNING id`,
      [back],
    );
    for (const r of rebuild) await enqueueDerivative(r.id);
  }
  return restored;
}

// One row of the "Missing files" triage list (cf. /api/failures).
export type MissingItem = {
  asset_id: number;
  filename: string;
  abs_path: string;
  media_type: string;
  session_id: number;
  file_size: number | null;
  missing_at: string;
  // True when the detector auto-trashed it (reversible); false when the
  // mass-disappearance guard left it flagged in the live library.
  trashed: boolean;
};

export async function listMissing(limit = 200): Promise<MissingItem[]> {
  return many<MissingItem>(
    `SELECT id AS asset_id, filename, abs_path, media_type, session_id,
            file_size, missing_at,
            (deleted_at IS NOT NULL) AS trashed
       FROM assets
      WHERE missing_at IS NOT NULL AND purged_at IS NULL
      ORDER BY missing_at DESC
      LIMIT ${limit}`,
  );
}
