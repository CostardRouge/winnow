// GET /api/sessions/:id/assets ?cursor&filter… → grille paginée (cursor-based).
// Jamais d'OFFSET : keyset sur (captured_at, id). La grille front est virtualisée.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, FilterSchema } from "@/lib/filter";
import {
  json,
  badRequest,
  serverError,
  encodeCursor,
  decodeCursor,
} from "@/lib/api";
import type { AssetGridRow } from "@/lib/types";

const PAGE = 200;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    const sp = req.nextUrl.searchParams;

    const parsed = FilterSchema.safeParse({
      verdict: sp.get("verdict") ?? undefined,
      star_min: sp.get("star_min") ?? undefined,
      media_type: sp.get("media_type") ?? undefined,
      device: sp.get("device") ?? undefined,
      processing_state: sp.get("processing_state") ?? undefined,
      has_gps: sp.get("has_gps") ?? undefined,
    });
    if (!parsed.success) return badRequest("Filtre invalide", parsed.error.issues);

    const filter = { ...parsed.data, session_id: sessionId };
    const { conditions, params: fParams } = buildFilter(filter, 1);

    let idx = fParams.length + 1;
    const cursorStr = sp.get("cursor");
    if (cursorStr) {
      const cur = decodeCursor(cursorStr);
      if (!cur) return badRequest("Cursor invalide");
      conditions.push(`(a.captured_at, a.id) > ($${idx++}, $${idx++})`);
      fParams.push(cur.capturedAt, cur.id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await many<AssetGridRow>(
      `SELECT a.*,
              COALESCE(r.verdict, 'unrated') AS verdict,
              COALESCE(r.star, 0)            AS star,
              r.color_label
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
       ORDER BY a.captured_at ASC, a.id ASC
       LIMIT $${idx}`,
      [...fParams, PAGE + 1],
    );

    const hasMore = rows.length > PAGE;
    const page = hasMore ? rows.slice(0, PAGE) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last?.captured_at
        ? encodeCursor(last.captured_at, last.id)
        : null;

    return json({ assets: page, next_cursor: nextCursor });
  } catch (err) {
    return serverError(err);
  }
}
