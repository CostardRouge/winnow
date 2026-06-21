// GET /api/assets ?<cumulative filters>&cursor → paginated global gallery.
// Keyset on (captured_at, id) DESC (most recent first). Never OFFSET.
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

    // `?deleted=trash` lists the recycle bin (soft-deleted, not purged); the
    // default shows the live library.
    const deleted = sp.get("deleted") === "trash" ? "trash" : "exclude";
    // `?collapse=1` shows one tile per logical media: RAW+JPEG companions are
    // hidden so a pair counts once (the displayed `primary` stays). Off by
    // default — the Pipeline/triage views list every file.
    const collapseGroups = sp.get("collapse") === "1";
    const { conditions, params } = buildFilter(filter, 1, {
      deleted,
      collapseGroups,
    });
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
      `SELECT ${GRID_SELECT}
       ${GRID_FROM}
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
