// GET /api/assets/:id/faces → the faces detected in one asset, with who they
// are (cf. lib/people.ts) and where they sit (pixel bbox in the ANALYZED
// derivative + that derivative's dimensions, so the viewer can project the box
// onto whatever rendition it displays). Drives the MediaViewer's face chips
// and the on-media face boundaries. Best faces first, same as everywhere.
import { many } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const assetId = Number.parseInt(id, 10);
    if (!Number.isFinite(assetId)) return badRequest("Invalid asset id");

    const faces = await many(
      `SELECT f.id, f.person_id, p.name AS person_name, f.score,
              f.x1, f.y1, f.x2, f.y2, f.img_width, f.img_height
         FROM asset_faces f
         LEFT JOIN people p ON p.id = f.person_id
        WHERE f.asset_id = $1
        ORDER BY f.score DESC, f.id`,
      [assetId],
    );
    return json({ faces });
  } catch (err) {
    return serverError(err);
  }
}
