// POST /api/failures/retry { kind, ids? } → relance les éléments échoués.
//   kind="derivative" : remet les assets en 'pending' et ré-enfile la génération
//                       (ids = asset ids ; sinon tous les dérivés en erreur).
//   kind="scan"       : ré-indexe les roots (incoming prioritaire) et marque les
//                       échecs de scan comme réglés (réouverts s'ils re-échouent).
//   kind="import"     : ré-importe la quarantaine (.failed) — succès = sort de
//                       quarantaine ; échec = y reste.
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
    if (!parsed.success) return badRequest("kind requis", parsed.error.issues);
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
      // Résolution optimiste : si un fichier re-échoue, recordScanFailure rouvre.
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

    // import : ré-importe la quarantaine (batch tracké pour que d'éventuels
    // ré-échecs restent visibles dans la liste).
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
