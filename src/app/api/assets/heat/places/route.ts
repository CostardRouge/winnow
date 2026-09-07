// GET /api/assets/heat/places ?<cumulative filters>
// → per-place tallies broken down by month: the map's bins and the matrix's
//   rows come from one read, so the two never disagree.
//
// The bins are the reverse-geocoding cells that already exist
// (`places(cell_lat, cell_lon, precision_m)`), which is why this route needs
// no clustering and no PostGIS — see the header of lib/heat.ts for what that
// buys and what it costs. Bounded by construction: a fixed number of places
// times the months they hold, so there is no 10 000-point cap to hit the way
// /api/assets/geo has one.
//
// A brushed span or a picked month reaches this route as the ordinary
// `date_from` / `date_to` filters, the same pair the Calendar's day hand-off
// uses — the heatmap invents no filter of its own.
import { NextRequest } from "next/server";
import { heatPlaces } from "@/lib/heat";
import { filterFromSearchParams } from "@/lib/filter";
import { featureOff } from "@/lib/featureGate";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // The heatmap owns this route outright — nothing else reads it.
  const off = await featureOff("heatmap");
  if (off) return off;

  try {
    let filter;
    try {
      filter = filterFromSearchParams(req.nextUrl.searchParams);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }
    return json(await heatPlaces(filter));
  } catch (err) {
    return serverError(err);
  }
}
