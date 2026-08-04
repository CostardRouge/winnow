// One person.
//   GET   → the person + their face list (best first) — feeds the detail
//           header and the cover picker (each face renders via
//           /api/faces/:id/thumb and belongs to a live asset).
//   PATCH → rename ({ name }) and/or choose the stack cover
//           ({ cover_face_id }, validated to be one of THIS person's faces).
//           Both fields nullable: clearing the name returns the stack to
//           "Unnamed", clearing the cover returns it to the automatic best
//           face. Editor-gated by the authz default (mutations = editor).
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one, q } from "@/lib/db";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

// The cover picker shows at most this many candidate faces; beyond it the
// extra crops add scroll, not signal (they're the person's worst detections).
const FACES_CAP = 200;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const personId = Number.parseInt(id, 10);
    if (!Number.isFinite(personId)) return badRequest("Invalid person id");

    const person = await one(
      `SELECT p.id, p.name,
              c.face_count, c.asset_count,
              COALESCE(cov.id, best.id) AS cover_face_id
         FROM people p
        CROSS JOIN LATERAL (
          SELECT count(*)::int                  AS face_count,
                 count(DISTINCT f.asset_id)::int AS asset_count
            FROM asset_faces f
            JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
           WHERE f.person_id = p.id
        ) c
         LEFT JOIN LATERAL (
          SELECT f.id
            FROM asset_faces f
            JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
           WHERE f.id = p.cover_face_id AND f.person_id = p.id
        ) cov ON true
         LEFT JOIN LATERAL (
          SELECT f.id
            FROM asset_faces f
            JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
           WHERE f.person_id = p.id
           ORDER BY f.score DESC, f.id
           LIMIT 1
        ) best ON true
        WHERE p.id = $1`,
      [personId],
    );
    if (!person) return notFound("Person not found");

    const faces = await many(
      `SELECT f.id, f.asset_id, f.score
         FROM asset_faces f
         JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
        WHERE f.person_id = $1
        ORDER BY f.score DESC, f.id
        LIMIT ${FACES_CAP}`,
      [personId],
    );
    return json({ person, faces });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    cover_face_id: z.number().int().nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.cover_face_id !== undefined, {
    message: "nothing to update",
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const personId = Number.parseInt(id, 10);
    if (!Number.isFinite(personId)) return badRequest("Invalid person id");

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues);
    const { name, cover_face_id } = parsed.data;

    const exists = await one(`SELECT id FROM people WHERE id = $1`, [personId]);
    if (!exists) return notFound("Person not found");

    if (cover_face_id != null) {
      // The cover must be one of this person's own faces — anything else would
      // front the stack with a stranger.
      const face = await one(
        `SELECT id FROM asset_faces WHERE id = $1 AND person_id = $2`,
        [cover_face_id, personId],
      );
      if (!face) return badRequest("cover_face_id is not a face of this person");
    }

    await q(
      `UPDATE people SET
         name          = CASE WHEN $2::boolean THEN $3::text   ELSE name          END,
         cover_face_id = CASE WHEN $4::boolean THEN $5::bigint ELSE cover_face_id END,
         updated_at    = now()
       WHERE id = $1`,
      [
        personId,
        name !== undefined,
        // An empty (whitespace) name is a clear, not a name.
        name || null,
        cover_face_id !== undefined,
        cover_face_id,
      ],
    );
    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
