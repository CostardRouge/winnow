// CLI helper: parse the telemetry of DJI .SRT sidecars already indexed as opaque
// companions (before lib/srt.ts existed, or imported by an older build). For each
// .srt it re-reads the file, fills the sidecar's gps/altitude/sample columns, and
// — when the parent clip has no GPS of its own — backfills the clip's location
// from the flight log and enqueues a reverse-geocode. No NAS re-scan needed; the
// sidecars are already recorded. Idempotent.
//
// Usage:
//   npm run srt-backfill              # only .srt not yet parsed (sample_count NULL)
//   npm run srt-backfill -- --force   # re-parse every .srt (e.g. after a parser fix)
// Then run `npm run worker` (or leave it running) to drain any geocode jobs.
import { readFile } from "node:fs/promises";
import { many, q, pool } from "../lib/db";
import { parseDjiSrt } from "../lib/srt";
import { enqueueGeocode } from "../lib/queue";
import { config } from "../lib/config";

async function main() {
  const force = process.argv.slice(2).includes("--force");

  const rows = await many<{ id: number; abs_path: string; asset_id: number }>(
    force
      ? `SELECT id, abs_path, asset_id FROM asset_sidecars
           WHERE kind = 'srt' ORDER BY id`
      : `SELECT id, abs_path, asset_id FROM asset_sidecars
           WHERE kind = 'srt' AND sample_count IS NULL ORDER BY id`,
  );

  console.log(
    `Parsing ${rows.length} DJI .SRT sidecar(s)${force ? " (force: re-parse all)" : ""}…`,
  );

  let parsed = 0;
  let located = 0;
  let geocoded = 0;
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
    if (tel) parsed++;

    // Backfill the clip's location only when it has none of its own.
    if (tel?.gpsLat != null && tel.gpsLon != null) {
      const upd = await q(
        "UPDATE assets SET gps = $1 WHERE id = $2 AND gps IS NULL AND deleted_at IS NULL",
        [JSON.stringify({ lat: tel.gpsLat, lon: tel.gpsLon }), r.asset_id],
      );
      if (upd.rowCount) {
        located++;
        if (config.geocode.enabled) {
          await enqueueGeocode(r.asset_id);
          geocoded++;
        }
      }
    }
  }

  console.log(
    `Done. Parsed ${parsed}, backfilled location for ${located} clip(s), ` +
      `queued ${geocoded} geocode job(s). Run \`npm run worker\` to process them.`,
  );

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
