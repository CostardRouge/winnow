// PATCH  /api/roots/:id { type?, watch?, reindex? } -> update a volume
// DELETE /api/roots/:id                              -> remove a volume (cascade)
//
// Changing the type re-maps roots.kind; switching to a walkable kind (or passing
// reindex) re-enqueues an indexing scan so the volume is (re)indexed under its
// new role. Removing a volume cascades to its sessions/assets/ratings — the
// originals on the NAS are never touched (we only ever read them).
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import { enqueueIndex } from "@/lib/queue";
import { json, badRequest, notFound, serverError } from "@/lib/api";
import { isWalkable, kindForType } from "@/lib/volumes";
import type { Root } from "@/lib/types";

const Body = z
  .object({
    type: z.enum(["incoming", "final", "export"]).optional(),
    watch: z.boolean().optional(),
    reindex: z.boolean().optional(),
  })
  .refine((b) => b.type !== undefined || b.watch !== undefined || b.reindex, {
    message: "type, watch or reindex required",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const rootId = Number.parseInt(id, 10);
    if (!Number.isFinite(rootId)) return badRequest("Invalid id");

    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("type, watch or reindex required");
    const { type, watch, reindex } = parsed.data;

    const kind = type ? kindForType(type) : undefined;
    const root = await one<Root>(
      `UPDATE roots
         SET kind  = COALESCE($2, kind),
             watch = COALESCE($3, watch)
       WHERE id = $1
       RETURNING *`,
      [rootId, kind ?? null, watch ?? null],
    );
    if (!root) return notFound("Volume not found");

    // Re-scan when asked explicitly, or when the (new) kind is walkable and the
    // type changed — so a folder flipped to Incoming/Final gets picked up.
    if (root && isWalkable(root.kind) && (reindex || kind !== undefined)) {
      await enqueueIndex(root.id);
    }
    return json({ root });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const rootId = Number.parseInt(id, 10);
    if (!Number.isFinite(rootId)) return badRequest("Invalid id");

    const root = await one<Root>(
      "DELETE FROM roots WHERE id = $1 RETURNING *",
      [rootId],
    );
    if (!root) return notFound("Volume not found");
    return json({ root });
  } catch (err) {
    return serverError(err);
  }
}
