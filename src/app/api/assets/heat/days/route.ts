// GET /api/assets/heat/days ?<cumulative filters>&place=<place_id>
// → per-day tallies for the heatmap's calendar readings: frames, picks and
//   never-triaged, one row per capture date, plus the day's dominant place (as
//   a tint slot), the full filtered span and the undated pile.
//
// Days are the `capture_date` column, which is materialized in **UTC**. Winnow
// carries no per-asset timezone, and the Timeline's trick — deriving a local
// day from `round(medianLon / 15)` per chapter — has no meaning for a grid
// spanning the whole library. So the convention is UTC and the panel says so,
// rather than a fix that would be wrong in a different way.
//
// Cheap by construction: one row per day (~3 650 for a decade), covered by
// `assets_capture_date_idx`, and no per-day cover thumbnail (see lib/heat.ts).
import { NextRequest } from "next/server";
import { heatDays } from "@/lib/heat";
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
    const sp = req.nextUrl.searchParams;
    let filter;
    try {
      filter = filterFromSearchParams(sp);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }

    const raw = sp.get("place");
    let placeId: number | null = null;
    if (raw != null && raw !== "") {
      placeId = Number.parseInt(raw, 10);
      if (!Number.isInteger(placeId)) return badRequest("place must be an integer");
    }

    return json(await heatDays(filter, placeId));
  } catch (err) {
    return serverError(err);
  }
}
