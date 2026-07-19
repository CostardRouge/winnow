// POST /api/failures/retry { kind, ids?, paths? } -> retries the failed items.
//   kind="derivative" : resets the assets to 'pending' and re-enqueues generation
//                       (ids = asset ids; otherwise all derivatives in error).
//   kind="scan"       : re-indexes the roots (incoming prioritized) and marks the
//                       scan failures as resolved (reopened if they fail again).
//                       (paths = abs_paths of the files to retry → only their
//                       roots are re-scanned; otherwise every open scan failure.)
//   kind="import"     : re-imports the quarantine (.failed) -- success = leaves
//                       quarantine; failure = stays there. (Whole-quarantine only:
//                       a recorded error path can't be mapped back to a single
//                       quarantined file, so there is no per-file import retry.)
//   kind="missing"    : re-stats the missing originals (ids, or all) — whichever
//                       answer again are restored (flag + auto-trash lifted, a
//                       broken derivative re-enqueued). Cf. lib/integrity.ts.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one, q } from "@/lib/db";
import { config } from "@/lib/config";
import {
  enqueueIndex,
  enqueueDerivative,
  enqueueImport,
  enqueueMl,
  PRIORITY,
} from "@/lib/queue";
import { quarantineDir } from "@/lib/import";
import { recheckMissing } from "@/lib/integrity";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(["derivative", "scan", "import", "missing", "ml"]),
  ids: z.array(z.number().int()).optional(),
  paths: z.array(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("kind required", parsed.error.issues);
    const { kind, ids, paths } = parsed.data;

    if (kind === "derivative") {
      const rows =
        ids && ids.length
          ? await many<{ id: number }>(
              "SELECT id FROM assets WHERE id = ANY($1) AND derivative_status = 'error'",
              [ids],
            )
          : await many<{ id: number }>(
              "SELECT id FROM assets WHERE derivative_status = 'error'",
            );
      const idList = rows.map((r) => r.id);
      if (idList.length) {
        await q(
          "UPDATE assets SET derivative_status='pending', derivative_error=NULL, updated_at=now() WHERE id = ANY($1)",
          [idList],
        );
        for (const id of idList) await enqueueDerivative(id);
      }
      return json({ kind, retried: idList.length });
    }

    if (kind === "ml") {
      // Re-run ML analysis for the errored assets. Guard on the feature being
      // on (the job is a no-op with ML off) and on a derivative existing — the
      // models feed on the proxy/poster, never the RAW, so a row with no
      // derivative can never be analyzed and is left as-is.
      if (!config.ml.enabled) {
        return json({ kind, retried: 0 });
      }
      const rows =
        ids && ids.length
          ? await many<{ id: number }>(
              `SELECT id FROM assets
                WHERE id = ANY($1) AND ml_status = 'error' AND deleted_at IS NULL
                  AND (CASE WHEN media_type = 'video' THEN thumb_key
                            ELSE COALESCE(proxy_key, thumb_key) END) IS NOT NULL`,
              [ids],
            )
          : await many<{ id: number }>(
              `SELECT id FROM assets
                WHERE ml_status = 'error' AND deleted_at IS NULL
                  AND (CASE WHEN media_type = 'video' THEN thumb_key
                            ELSE COALESCE(proxy_key, thumb_key) END) IS NOT NULL`,
            );
      const idList = rows.map((r) => r.id);
      if (idList.length) {
        await q(
          "UPDATE assets SET ml_status='pending', ml_error=NULL, updated_at=now() WHERE id = ANY($1)",
          [idList],
        );
        for (const id of idList) await enqueueMl(id);
      }
      return json({ kind, retried: idList.length });
    }

    if (kind === "scan") {
      // Per-file retry: resolve only the selected failures and re-scan just the
      // roots that own them (re-indexing is incremental, so untouched files are
      // skipped). Optimistic: if a file fails again, recordScanFailure reopens it.
      if (paths && paths.length) {
        await q(
          "UPDATE scan_failures SET resolved_at = now() WHERE abs_path = ANY($1) AND resolved_at IS NULL",
          [paths],
        );
        let roots = await many<{ id: number; path: string }>(
          `SELECT DISTINCT r.id, r.path
             FROM roots r
             JOIN scan_failures f ON f.root_id = r.id
            WHERE f.abs_path = ANY($1)`,
          [paths],
        );
        // Fallback for legacy rows without a root_id: re-scan every source/inbox.
        if (!roots.length) {
          roots = await many<{ id: number; path: string }>(
            "SELECT id, path FROM roots WHERE kind IN ('source','inbox')",
          );
        }
        for (const r of roots) {
          await enqueueIndex(r.id, {
            priority:
              r.path === config.import.incomingDir
                ? PRIORITY.high
                : PRIORITY.normal,
          });
        }
        return json({ kind, retried: paths.length });
      }

      // Retry all: resolve every open scan failure and re-scan the roots.
      await q(
        "UPDATE scan_failures SET resolved_at = now() WHERE resolved_at IS NULL",
      );
      const roots = await many<{ id: number; path: string }>(
        "SELECT id, path FROM roots WHERE kind IN ('source','inbox')",
      );
      for (const r of roots) {
        await enqueueIndex(r.id, {
          priority:
            r.path === config.import.incomingDir
              ? PRIORITY.high
              : PRIORITY.normal,
        });
      }
      return json({ kind, retried: roots.length });
    }

    if (kind === "missing") {
      // Re-check: whichever files answer a stat again come back to the library
      // (auto-trash lifted); the rest stay listed for restore/purge triage.
      const restored = await recheckMissing(ids);
      return json({ kind, retried: restored });
    }

    // import: re-imports the quarantine (batch tracked so that any further
    // failures stay visible in the list).
    const batch = await one<{ id: number }>(
      "INSERT INTO import_batches (source_dir, origin) VALUES ($1, 'inbox') RETURNING id",
      [quarantineDir],
    );
    await enqueueImport({
      sourceDir: quarantineDir,
      origin: "inbox",
      removeAfter: true,
      batchId: batch?.id,
    });
    return json({ kind, retried: 1 });
  } catch (err) {
    return serverError(err);
  }
}
