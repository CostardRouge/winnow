// CLI helper: enqueue a reverse-geocode job for every geotagged asset that has
// no place yet — the one-shot backfill of an existing library (no re-scan of the
// NAS needed; we already have the coordinates). Idempotent: re-running only
// picks up assets still missing a place, and the cell cache means most jobs make
// no network call at all.
//
// Usage:
//   npm run geocode-backfill              # enqueue onto the geocode queue
//   npm run geocode-backfill -- --force   # also re-enqueue assets already resolved
//                                         # (e.g. after lowering the precision)
// Then run `npm run worker` (or leave it running) to drain the queue.
import { many, pool } from "../lib/db";
import { enqueueGeocode } from "../lib/queue";

async function main() {
  const force = process.argv.slice(2).includes("--force");

  // Only geotagged, live assets. Without --force we skip anything already linked
  // to a place; the partial index assets_geocode_todo_idx serves exactly this set.
  const rows = await many<{ id: number }>(
    force
      ? `SELECT id FROM assets
           WHERE gps_lat IS NOT NULL AND deleted_at IS NULL
           ORDER BY id`
      : `SELECT id FROM assets
           WHERE gps_lat IS NOT NULL AND deleted_at IS NULL AND place_id IS NULL
           ORDER BY id`,
  );

  console.log(
    `Enqueuing ${rows.length} geocode job(s)${force ? " (force: includes already-resolved)" : ""}…`,
  );
  let n = 0;
  for (const r of rows) {
    await enqueueGeocode(r.id);
    if (++n % 1000 === 0) console.log(`  queued ${n}/${rows.length}`);
  }
  console.log(`Done. Queued ${n}. Run \`npm run worker\` to process them.`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
