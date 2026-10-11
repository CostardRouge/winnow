// GET /api/assets/unplaced/places?from=<instant>&to=<instant> → the positions a
// human already applied within reuse_d days of that window, nearest first —
// what the Unplaced view's Place dialog offers as one-click choices ("same
// place as the folder I did yesterday"). Offered only: nothing here seeds a
// suggestion (src/lib/unplaced.ts, placesNear).
import { NextRequest } from "next/server";
import { placesNear } from "@/lib/unplaced";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const from = req.nextUrl.searchParams.get("from");
    const to = req.nextUrl.searchParams.get("to");
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return badRequest("from and to (instants) required");
    }
    return json({ places: await placesNear(from, to) });
  } catch (err) {
    return serverError(err);
  }
}
