// GET /api/sessions/:id/assets ?cursor&limit&filter... → paginated grid (cursor-based).
// Never OFFSET: keyset on (captured_at, id). The front-end grid is virtualized.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { GRID_SELECT, GRID_FROM } from "@/lib/assetQuery";
import {
  json,
  badRequest,
  serverError,
  encodeCursor,
  decodeCursor,
  pageSize,
} from "@/lib/api";
import type { AssetGridRow } from "@/lib/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    const sp = req.nextUrl.searchParams;

    let filter;
    try {
      filter = { ...filterFromSearchParams(sp), session_id: sessionId };
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }
    const collapseGroups = sp.get("collapse") === "1";
    const { conditions, params: fParams } = buildFilter(filter, 1, {
      collapseGroups,
    });

    let idx = fParams.length + 1;
    const cursorStr = sp.get("cursor");
    if (cursorStr) {
      const cur = decodeCursor(cursorStr);
      if (!cur) return badRequest("Invalid cursor");
      conditions.push(`(a.captured_at, a.id) > ($${idx++}, $${idx++})`);
      fParams.push(cur.capturedAt, cur.id);
    }

    const limit = pageSize(sp);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await many<AssetGridRow>(
      `SELECT ${GRID_SELECT}
       ${GRID_FROM}
       ${where}
       ORDER BY a.captured_at ASC, a.id ASC
       LIMIT $${idx}`,
      [...fParams, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
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
