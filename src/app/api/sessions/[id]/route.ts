// PATCH /api/sessions/:id { ignored?, completed? } -> updates the folder.
//  - ignored : marks as processed; cascades processing_state=ignored and stops
//    derivatives (§5). Inverse: resets to `unprocessed` and re-enqueues the missing ones.
//  - completed : simple visual flag (badge), no cascade or processing.
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
    message: "ignored or completed required",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ignored or completed required");
    const { ignored, completed } = parsed.data;

    let session: Session | null = null;

    // "completed" flag: pure flip, without touching the assets.
    if (completed !== undefined) {
      session = await one<Session>(
        "UPDATE sessions SET completed = $2 WHERE id = $1 RETURNING *",
        [sessionId, completed],
      );
      if (!session) return notFound("Session not found");
    }

    if (ignored === undefined) {
      return json({ session });
    }

    session = await one<Session>(
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
