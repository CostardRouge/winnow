// POST /api/assets/geotag { ids[], lat, lon } -> manually sets the GPS position
// of the given assets (the geotag action: session shot with a camera that had
// no fix). The caller has already confirmed the per-asset before/after in the
// recap modal — including any explicit overwrite of an existing position — so
// this applies to every id verbatim (live assets only).
//
// Three effects per asset:
//   1. DB: gps = the chosen point, gps_source = 'manual';
//   2. re-resolve the place names at the new coordinates (geocode queue,
//      precise: it's a hand-triggered action, we want the POI too);
//   3. write the coordinates back into the ORIGINAL file's EXIF (gpswrite
//      queue, cf. lib/exifWrite.ts) so the value survives outside winnow —
//      the Capture One export is a plain byte copy and picks it up for free.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, q } from "@/lib/db";
import { config } from "@/lib/config";
import { enqueueGeocode, enqueueGpsWrite } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("ids, lat, lon required", parsed.error.issues);
    const { ids, lat, lon } = parsed.data;

    // Live assets only — the recycle bin and purged rows keep their history.
    const rows = await many<{ id: number }>(
      `UPDATE assets SET
         gps=$2::jsonb, gps_source='manual',
         gps_write_status='pending', gps_write_error=NULL,
         geocode_status='pending', geocode_error=NULL,
         updated_at=now()
       WHERE id = ANY($1) AND deleted_at IS NULL AND purged_at IS NULL
       RETURNING id`,
      [ids, JSON.stringify({ lat, lon })],
    );

    for (const { id } of rows) {
      await enqueueGpsWrite(id);
      if (config.geocode.enabled) await enqueueGeocode(id, { precise: true });
    }
    return json({ updated: rows.length, skipped: ids.length - rows.length });
  } catch (err) {
    return serverError(err);
  }
}
