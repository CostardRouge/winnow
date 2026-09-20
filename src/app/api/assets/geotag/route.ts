// POST /api/assets/geotag { ids[], lat, lon, source? } -> sets the GPS position
// of the given assets by hand (the geotag action: a session shot with a camera
// that had no fix). The caller has already confirmed the per-asset before/after
// in the recap modal — including any explicit overwrite of an existing position
// — so this applies to every id verbatim (live assets only).
//
// `source` says what kind of human act this was (docs/UNPLACED.md §4.2):
//   'manual'   (default) a pin placed knowing where the shot was taken;
//   'inferred' a folder-scale suggestion accepted in bulk, each frame unverified.
// The two are deliberately not interchangeable, and the difference is in what
// happens to the ORIGINAL file:
//
//   1. DB: gps = the chosen point, gps_source = `source` — for both;
//   2. re-resolve the place names at the new coordinates (geocode queue,
//      precise: it's a hand-triggered action, we want the POI too) — for both;
//   3. write the coordinates back into the ORIGINAL file's EXIF (gpswrite
//      queue, cf. lib/exifWrite.ts) so the value survives outside winnow — the
//      Capture One export is a plain byte copy and picks it up for free —
//      **for 'manual' only**. An 'inferred' position never enters the file: a
//      re-index reads the file's EXIF back as truth and would reset gps_source
//      to NULL, laundering a bulk guess into what looks like a camera fix
//      within one scan (docs/UNPLACED.md §4.3). It stays true in the database
//      (the indexer keeps it, cf. lib/indexer.ts) and is served live by the API.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many } from "@/lib/db";
import { config } from "@/lib/config";
import { enqueueGeocode, enqueueGpsWrite } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int()).min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  source: z.enum(["manual", "inferred"]).default("manual"),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("ids, lat, lon required", parsed.error.issues);
    const { ids, lat, lon, source } = parsed.data;
    const writeBack = source === "manual";

    // Live assets only — the recycle bin and purged rows keep their history.
    // An 'inferred' apply leaves gps_write_status at 'skipped' (nothing to
    // write); re-applying a manual pin over an inferred one arms it again.
    const rows = await many<{ id: number }>(
      `UPDATE assets SET
         gps=$2::jsonb, gps_source=$3,
         gps_write_status=CASE WHEN $4 THEN 'pending' ELSE 'skipped' END,
         gps_write_error=NULL,
         geocode_status='pending', geocode_error=NULL,
         updated_at=now()
       WHERE id = ANY($1) AND deleted_at IS NULL AND purged_at IS NULL
       RETURNING id`,
      [ids, JSON.stringify({ lat, lon }), source, writeBack],
    );

    for (const { id } of rows) {
      if (writeBack) await enqueueGpsWrite(id);
      if (config.geocode.enabled) await enqueueGeocode(id, { precise: true });
    }
    return json({ updated: rows.length, skipped: ids.length - rows.length, source });
  } catch (err) {
    return serverError(err);
  }
}
