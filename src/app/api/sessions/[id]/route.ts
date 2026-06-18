// PATCH /api/sessions/:id { ignored } → marque le dossier traité.
// Cascade processing_state=ignored et stoppe la génération de dérivés (§5).
// Inverse : remet les assets en `unprocessed` et ré-enfile les dérivés manquants.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one, q } from "@/lib/db";
import { enqueueDerivative } from "@/lib/queue";
import { json, badRequest, notFound, serverError } from "@/lib/api";
import type { Session } from "@/lib/types";

const Body = z.object({ ignored: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ignored requis");

    const session = await one<Session>(
      "UPDATE sessions SET ignored = $2 WHERE id = $1 RETURNING *",
      [sessionId, parsed.data.ignored],
    );
    if (!session) return notFound("Session introuvable");

    if (parsed.data.ignored) {
      // Cascade : tout passe en ignored ; on coupe les dérivés en attente.
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
      // Réactivation : on repasse en unprocessed et on régénère les dérivés
      // manquants des photos.
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
           AND media_type = 'photo'
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
