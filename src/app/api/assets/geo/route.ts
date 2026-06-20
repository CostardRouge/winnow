// GET /api/assets/geo ?<cumulative filters> → lightweight GPS points for the
// map view: just { id, lat, lon } for every geotagged asset matching the
// filters. Not paginated (the map plots the whole set at once) but capped, so a
// huge library can't blow up the payload; `truncated` flags when the cap is hit.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

const CAP = 10000;

export async function GET(req: NextRequest) {
  try {
    let filter;
    try {
      filter = filterFromSearchParams(req.nextUrl.searchParams);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }

    const { conditions, params } = buildFilter(filter, 1);
    // Only geotagged assets land on the map.
    conditions.push(`a.gps_lat IS NOT NULL`);
    const where = `WHERE ${conditions.join(" AND ")}`;
    const idx = params.length + 1;

    const rows = await many<{ id: number; lat: number; lon: number }>(
      `SELECT a.id, a.gps_lat AS lat, a.gps_lon AS lon
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       ${where}
       ORDER BY a.captured_at DESC NULLS LAST, a.id DESC
       LIMIT $${idx}`,
      [...params, CAP + 1],
    );

    const truncated = rows.length > CAP;
    return json({ points: truncated ? rows.slice(0, CAP) : rows, truncated });
  } catch (err) {
    return serverError(err);
  }
}
