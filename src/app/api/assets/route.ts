// GET /api/assets ?<cumulative filters>&cursor → paginated global gallery.
// Keyset on (captured_at, id) DESC (most recent first). Never OFFSET.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import {
  json,
  badRequest,
  serverError,
  encodeCursor,
  decodeCursor,
} from "@/lib/api";
import type { AssetGridRow } from "@/lib/types";

const PAGE = 200;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let filter;
    try {
      filter = filterFromSearchParams(sp);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }

    const { conditions, params } = buildFilter(filter, 1);
    let idx = params.length + 1;

    // Sort key: default is the capture timeline (most recent shots first); the
    // Pipeline triage pages pass `sort=recent` to surface what was *touched* last
    // (most recent updated_at) — i.e. the latest derivatives processed / queued.
    const recent = sp.get("sort") === "recent";
    const sortCol = recent ? "a.updated_at" : "a.captured_at";

    // Sort direction (default newest/most-recent first). `asc` flips both the
    // ORDER BY and the keyset comparison so pagination keeps walking forward.
    const dir = sp.get("sort_dir") === "asc" ? "ASC" : "DESC";
    const cmp = dir === "ASC" ? ">" : "<";

    const cursorStr = sp.get("cursor");
    if (cursorStr) {
      const cur = decodeCursor(cursorStr);
      if (!cur) return badRequest("Invalid cursor");
      conditions.push(`(${sortCol}, a.id) ${cmp} ($${idx++}, $${idx++})`);
      params.push(cur.capturedAt, cur.id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await many<AssetGridRow>(
      `SELECT a.*,
              COALESCE(r.verdict, 'unrated') AS verdict,
              COALESCE(r.star, 0)            AS star,
              r.color_label,
              (SELECT COALESCE(array_agg(t.name ORDER BY t.name), '{}')
                 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                WHERE at.asset_id = a.id) AS tags
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
       ORDER BY ${sortCol} ${dir}, a.id ${dir}
       LIMIT $${idx}`,
      [...params, PAGE + 1],
    );

    const hasMore = rows.length > PAGE;
    const page = hasMore ? rows.slice(0, PAGE) : rows;
    const last = page[page.length - 1];
    const sortVal = recent ? last?.updated_at : last?.captured_at;
    const nextCursor =
      hasMore && sortVal ? encodeCursor(sortVal, last.id) : null;

    return json({ assets: page, next_cursor: nextCursor });
  } catch (err) {
    return serverError(err);
  }
}
