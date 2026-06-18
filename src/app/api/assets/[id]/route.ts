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
              r.color_label
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
