// GET /api/assets/:id → detail + EXIF + culling state.
import { one } from "@/lib/db";
import { GRID_SELECT, GRID_FROM } from "@/lib/assetQuery";
import { json, notFound, serverError } from "@/lib/api";
import type { AssetGridRow } from "@/lib/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const asset = await one<AssetGridRow>(
      `SELECT ${GRID_SELECT}
       ${GRID_FROM}
       WHERE a.id = $1`,
      [Number.parseInt(id, 10)],
    );
    if (!asset) return notFound("Asset not found");
    return json({ asset });
  } catch (err) {
    return serverError(err);
  }
}
