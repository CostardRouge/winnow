// PATCH  /api/timeline/chapters/:id { name?, place_label?, place_lat?, place_lon? }
//        → edits a named span in place (bounds are immutable: to move an edge,
//          reset and draw a new span, so a span's identity stays its range).
// DELETE /api/timeline/chapters/:id → drops the correction; the chapter goes
//        back to being purely derived on the next request.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one, q } from "@/lib/db";
import { json, badRequest, notFound, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

const Patch = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    place_label: z.string().trim().min(1).max(200).nullable().optional(),
    place_lat: z.number().min(-90).max(90).nullable().optional(),
    place_lon: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine((b) => (b.place_lat === undefined) === (b.place_lon === undefined), {
    message: "place_lat and place_lon come together",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("bad id");
    const parsed = Patch.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid patch", parsed.error.issues);
    const b = parsed.data;

    // COALESCE-free on purpose: an explicit null clears the field (a renamed
    // chapter can go back to its derived name), an omitted one is untouched.
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (b.name !== undefined) set("name", b.name);
    if (b.place_label !== undefined) set("place_label", b.place_label);
    if (b.place_lat !== undefined) set("place_lat", b.place_lat);
    if (b.place_lon !== undefined) set("place_lon", b.place_lon);
    if (!sets.length) return badRequest("nothing to change");
    vals.push(id);

    const span = await one(
      `UPDATE timeline_chapters SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${vals.length}
       RETURNING id, starts_at, ends_at, name, place_label, place_lat, place_lon`,
      vals,
    );
    if (!span) return notFound();
    return json({ span });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("bad id");
    const r = await q("DELETE FROM timeline_chapters WHERE id = $1", [id]);
    if (!r.rowCount) return notFound();
    return json({ deleted: true });
  } catch (err) {
    return serverError(err);
  }
}
