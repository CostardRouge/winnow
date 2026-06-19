// POST /api/failures/retry { kind, ids? } -> retries the failed items.
//   kind="derivative" : resets the assets to 'pending' and re-enqueues generation
//                       (ids = asset ids; otherwise all derivatives in error).
//   kind="scan"       : re-indexes the roots (incoming prioritized) and marks the
//                       scan failures as resolved (reopened if they fail again).
//   kind="import"     : re-imports the quarantine (.failed) -- success = leaves
//                       quarantine; failure = stays there.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one, q } from "@/lib/db";
import { config } from "@/lib/config";
import {
  enqueueIndex,
  enqueueDerivative,
  enqueueImport,
  PRIORITY,
} from "@/lib/queue";
import { quarantineDir } from "@/lib/import";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(["derivative", "scan", "import"]),
  ids: z.array(z.number().int()).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("kind required", parsed.error.issues);
    const { kind, ids } = parsed.data;

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

    if (kind === "scan") {
      // Optimistic resolution: if a file fails again, recordScanFailure reopens it.
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
