// GET /api/assets/geotag/targets ?<cumulative filters> → the media a geotag
// would apply to, in the recap's own shape, in ONE unpaged request.
//
// The GET counterpart of the POST beside it: what the recap modal
// (GeotagRecapModal) needs to list, and nothing more. It exists because the
// callers that have no grid loaded — the session card's Geotag action, the
// session page's header, the Unplaced view's Place — used to page through
// /api/sessions/:id/assets, which returns the full GRID_SELECT projection
// (ratings, tags, companions, bursts, sidecars, the per-pair LATERALs) 500 rows
// at a time. A 3 886-frame folder was eight requests carrying tens of columns
// each to populate a table of five. This is one request and nine columns.
//
// Two rules the shape encodes:
//   - Pairs are NOT collapsed. Both members of a RAW+JPEG / Live Photo pair are
//     listed and written: the companion file needs the coordinates in its own
//     metadata too (the reason the old caller passed `collapse=0`).
//   - Exempted media are never targets. A human took them out of the backlog
//     for good (geo_exempt_at, cf. api/assets/geo-exempt); putting one back is
//     an explicit un-exempt, not a side effect of geotagging its folder.
//
// Unpaged because the caller needs every id to write them — but capped, so a
// filter that matches the whole library cannot build a 100 MB answer. Past the
// cap the answer is `truncated` and the client must refuse to apply rather than
// silently write a subset (the same contract as /api/assets/geo's points).
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

// Comfortably above the largest folder group this library can produce (the
// biggest single folder is ~3 900 frames) and far below a payload that hurts.
const CAP = 20000;

export async function GET(req: NextRequest) {
  try {
    let filter;
    try {
      filter = filterFromSearchParams(req.nextUrl.searchParams);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }
    // Refuse an unscoped call: without a scope this is "every live media in
    // the library", which is never what a geotag flow means to ask for.
    if (
      filter.ids == null &&
      filter.session_id == null &&
      filter.session_ids == null
    ) {
      return badRequest("ids, session_id or session_ids required");
    }

    const { conditions, params } = buildFilter(filter, 1);
    conditions.push("a.geo_exempt_at IS NULL");

    const rows = await many<{
      id: number;
      filename: string;
      media_type: "photo" | "video";
      gps: { lat: number; lon: number } | null;
      gps_source: "manual" | "inferred" | null;
      place_city: string | null;
      place_country: string | null;
      camera_model: string | null;
      lens: string | null;
    }>(
      `SELECT a.id, a.filename, a.media_type, a.gps, a.gps_source,
              a.place_city, a.place_country, a.camera_model, a.lens
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY a.captured_at ASC NULLS LAST, a.id ASC
       LIMIT $${params.length + 1}`,
      [...params, CAP + 1],
    );

    const truncated = rows.length > CAP;
    return json({ assets: truncated ? rows.slice(0, CAP) : rows, truncated });
  } catch (err) {
    return serverError(err);
  }
}
