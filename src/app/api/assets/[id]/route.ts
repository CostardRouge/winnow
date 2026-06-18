// GET /api/assets/:id → détail + EXIF + état de tri.
import { one } from "@/lib/db";
import { json, notFound, serverError } from "@/lib/api";
import type { AssetGridRow } from "@/lib/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const asset = await one<AssetGridRow>(
      `SELECT a.*,
              COALESCE(r.verdict, 'unrated') AS verdict,
              COALESCE(r.star, 0)            AS star,
              r.color_label,
              (SELECT COALESCE(array_agg(t.name ORDER BY t.name), '{}')
                 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                WHERE at.asset_id = a.id) AS tags
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE a.id = $1`,
      [Number.parseInt(id, 10)],
    );
    if (!asset) return notFound("Asset introuvable");
    return json({ asset });
  } catch (err) {
    return serverError(err);
  }
}
