// Places each frame at ITS OWN point — the write behind POST
// /api/assets/geotag/points (the thin wrapper) and the Unplaced view's
// "Follow a track…" (docs/UNPLACED.md §11), where a card's frames land where
// the track was at their own minute rather than all at one pin.
//
// The sibling of POST /api/assets/geotag (one point, many ids), with three
// differences that are the point of it:
//   - `source` is 'track' or 'inferred', never 'manual': the positions come
//     from a track, not from a human placing a pin, so nothing here is ever
//     written into an original (gps_write_status stays 'skipped'). 'track'
//     carries the import that measured it (track_import_id), so that import's
//     Undo takes these frames back as it takes back its own apply;
//   - it NEVER overwrites: only rows with no position are written. The recap's
//     per-row opt-in protects a placed frame in the one-pin flow; here the
//     dialog only ever lists unplaced frames, and the WHERE makes that true
//     even for a list that went stale while the dialog was open;
//   - each row gets its own coordinate, through one unnest per batch.
// Side effects as the one-pin route: names cleared then re-geocoded (cell
// mode — thousands of frames along one road share a few cells), and each
// frame's capture day re-decided from its new place.
import { tx } from "./db";
import { config } from "./config";
import { enqueueGeocodeBulk } from "./queue";
import { applyOwnZones } from "./captureDays";

export type GeotagPoint = {
  id: number;
  lat: number;
  lon: number;
  source: "track" | "inferred";
  import_id?: number | null;
};

const BATCH = 2000;

export async function writeGeotagPoints(
  points: GeotagPoint[],
): Promise<{ updated: number; skipped: number }> {
  const written: number[] = [];
  await tx(async (client) => {
    // A 'track' point must name an import that still exists: one undone
    // while the dialog was open, or none at all, would leave a 'track'
    // position no Undo can ever take back. Such points are skipped, not
    // failed — the rest of the write stands, and the count says so.
    const named = [...new Set(points.flatMap((p) => (p.source === "track" && p.import_id != null ? [p.import_id] : [])))];
    const alive = new Set<number>();
    if (named.length) {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM track_imports WHERE id = ANY($1::bigint[])",
        [named],
      );
      for (const r of rows) alive.add(Number(r.id));
    }
    const ok = points.filter((p) => p.source === "inferred" || (p.import_id != null && alive.has(p.import_id)));

    for (let i = 0; i < ok.length; i += BATCH) {
      const b = ok.slice(i, i + BATCH);
      // A frame ZONED by another import (its capture offset is that
      // import's) and now placed by this one: its zone is released for the
      // capture-day pass to re-decide from the new position. Kept, it would
      // ride on this import's id, and this import's Undo would take back the
      // other's zone (revertTrackImport clears 'track' offsets by id).
      const { rows } = await client.query<{ id: string }>(
        `UPDATE assets a SET
           gps = jsonb_build_object('lat', u.lat, 'lon', u.lon),
           gps_source = u.source,
           gps_write_status = 'skipped', gps_write_error = NULL,
           geocode_status = 'pending', geocode_error = NULL,
           place_id = NULL, place_country = NULL, place_region = NULL,
           place_county = NULL, place_city = NULL, place_poi = NULL,
           capture_offset_min = CASE
             WHEN u.source = 'track' AND a.capture_offset_source = 'track'
                  AND a.track_import_id IS DISTINCT FROM u.imp THEN NULL
             ELSE a.capture_offset_min END,
           capture_offset_source = CASE
             WHEN u.source = 'track' AND a.capture_offset_source = 'track'
                  AND a.track_import_id IS DISTINCT FROM u.imp THEN NULL
             ELSE a.capture_offset_source END,
           track_import_id = CASE WHEN u.source = 'track' THEN u.imp ELSE a.track_import_id END,
           updated_at = now()
         FROM unnest($1::bigint[], $2::float8[], $3::float8[], $4::text[], $5::bigint[])
              AS u(id, lat, lon, source, imp)
         WHERE a.id = u.id
           AND a.deleted_at IS NULL AND a.purged_at IS NULL
           AND a.gps IS NULL AND a.geo_exempt_at IS NULL
         RETURNING a.id`,
        [
          b.map((p) => p.id),
          b.map((p) => p.lat),
          b.map((p) => p.lon),
          b.map((p) => p.source),
          b.map((p) => (p.source === "track" ? p.import_id : null)),
        ],
      );
      for (const r of rows) written.push(Number(r.id));
    }
  });

  // One bulk add per thousand, not one Redis round trip per frame inside the
  // request (docs/SILENT-LIMITS-AUDIT.md F1).
  if (config.geocode.enabled && written.length) await enqueueGeocodeBulk(written);
  try {
    await applyOwnZones(written);
  } catch (err) {
    console.warn("[geotag/points] capture-day update failed:", (err as Error).message);
  }
  return { updated: written.length, skipped: points.length - written.length };
}
