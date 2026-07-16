// Shared DJI .SRT telemetry backfill (cf. lib/srt.ts). Parses the flight logs of
// sidecars already indexed as opaque companions — filling their gps/altitude/
// sample columns and, when the parent clip has no GPS of its own, inheriting the
// flight log's location and enqueuing a reverse-geocode. Idempotent.
//
// Used by both the CLI (`npm run srt-backfill`, src/scripts/srt-backfill.ts) and
// the one-click Pipeline action (POST /api/pipeline/srt-backfill) so a homelab
// can run it from the UI without a long docker/npm command.
import { readFile } from "node:fs/promises";
import { many, q } from "./db";
import { parseDjiSrt } from "./srt";
import { enqueueGeocode } from "./queue";
import { config } from "./config";

export type SrtBackfillResult = {
  // .SRT sidecars considered this run.
  scanned: number;
  // Files that yielded usable telemetry.
  parsed: number;
  // Clips that inherited a location from their flight log (had none before).
  located: number;
  // Reverse-geocode jobs enqueued for those clips.
  geocoded: number;
};

// Reparse every DJI .SRT sidecar (with `force`) or only those not yet parsed
// (`sample_count IS NULL`). Reads small text files off disk sequentially — safe
// on a spun-up NAS; the only slow, rate-limited step (geocoding) is offloaded to
// the existing geocode queue, so this returns promptly.
export async function runSrtBackfill(
  opts: { force?: boolean } = {},
): Promise<SrtBackfillResult> {
  const rows = await many<{ id: number; abs_path: string; asset_id: number }>(
    opts.force
      ? `SELECT id, abs_path, asset_id FROM asset_sidecars
           WHERE kind = 'srt' ORDER BY id`
      : `SELECT id, abs_path, asset_id FROM asset_sidecars
           WHERE kind = 'srt' AND sample_count IS NULL ORDER BY id`,
  );

  const result: SrtBackfillResult = {
    scanned: rows.length,
    parsed: 0,
    located: 0,
    geocoded: 0,
  };

  for (const r of rows) {
    let tel = null;
    try {
      tel = parseDjiSrt(await readFile(r.abs_path, "utf8"));
    } catch {
      // Unreachable/corrupt file: leave the columns NULL, move on.
    }

    await q(
      `UPDATE asset_sidecars
          SET gps_lat = $1, gps_lon = $2, max_altitude = $3,
              sample_count = $4, updated_at = now()
        WHERE id = $5`,
      [
        tel?.gpsLat ?? null,
        tel?.gpsLon ?? null,
        tel?.maxAltitude ?? null,
        tel?.sampleCount ?? null,
        r.id,
      ],
    );
    if (tel) result.parsed++;

    // Backfill the clip's location only when it has none of its own.
    if (tel?.gpsLat != null && tel.gpsLon != null) {
      const upd = await q(
        "UPDATE assets SET gps = $1 WHERE id = $2 AND gps IS NULL AND deleted_at IS NULL",
        [JSON.stringify({ lat: tel.gpsLat, lon: tel.gpsLon }), r.asset_id],
      );
      if (upd.rowCount) {
        result.located++;
        if (config.geocode.enabled) {
          await enqueueGeocode(r.asset_id);
          result.geocoded++;
        }
      }
    }
  }

  return result;
}
