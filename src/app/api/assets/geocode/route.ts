// POST /api/assets/geocode { ids[], precise? } -> resolves place names (country /
// région / département / city, plus a tourist POI) for the given assets from
// their GPS coordinates, on demand. This is the manual counterpart to the batch
// backfill — the "Resolve location" action in the media menus / bulk bar — so it
// defaults to `precise: true`: fetch at each asset's exact coordinate and fill
// the POI, not just the shared 5 km cell.
//
// Only geotagged, non-deleted assets are enqueued; the rest are reported as
// `skipped`. Mirrors /api/assets/regenerate: reset status to 'pending', clear any
// error, then enqueue onto the geocode queue.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, q } from "@/lib/db";
import { enqueueGeocode } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  // Default true: a hand-triggered lookup wants the exact-coordinate POI. Pass
  // false to only (re)fill the cheap shared-cell administrative names.
  precise: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ids required", parsed.error.issues);
    const { ids, precise = true } = parsed.data;

    // Geocodable = geotagged + live. Assets without coordinates can't be resolved.
    const rows = await many<{ id: number }>(
      "SELECT id FROM assets WHERE id = ANY($1) AND deleted_at IS NULL AND gps_lat IS NOT NULL",
      [ids],
    );
    const idList = rows.map((r) => r.id);
    if (idList.length) {
      await q(
        "UPDATE assets SET geocode_status='pending', geocode_error=NULL, updated_at=now() WHERE id = ANY($1)",
        [idList],
      );
      for (const id of idList) await enqueueGeocode(id, { precise });
    }
    return json({ queued: idList.length, skipped: ids.length - idList.length });
  } catch (err) {
    return serverError(err);
  }
}
