// PATCH /api/sessions/:id { ignored?, completed? } → met à jour le dossier.
//  - ignored : marque traité ; cascade processing_state=ignored et stoppe les
//    dérivés (§5). Inverse : remet en `unprocessed` et ré-enfile les manquants.
//  - completed : simple drapeau visuel (badge), aucune cascade ni traitement.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one, q } from "@/lib/db";
import { enqueueDerivative } from "@/lib/queue";
import { json, badRequest, notFound, serverError } from "@/lib/api";
import type { Session } from "@/lib/types";

const Body = z
  .object({
    ignored: z.boolean().optional(),
    completed: z.boolean().optional(),
  })
  .refine((b) => b.ignored !== undefined || b.completed !== undefined, {
    message: "ignored ou completed requis",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ignored ou completed requis");
    const { ignored, completed } = parsed.data;

    let session: Session | null = null;

    // Drapeau "terminé" : pur flip, sans toucher aux assets.
    if (completed !== undefined) {
      session = await one<Session>(
        "UPDATE sessions SET completed = $2 WHERE id = $1 RETURNING *",
        [sessionId, completed],
      );
      if (!session) return notFound("Session introuvable");
    }

    if (ignored === undefined) {
      return json({ session });
    }

    session = await one<Session>(
      "UPDATE sessions SET ignored = $2 WHERE id = $1 RETURNING *",
      [sessionId, ignored],
    );
    if (!session) return notFound("Session introuvable");

    if (ignored) {
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
