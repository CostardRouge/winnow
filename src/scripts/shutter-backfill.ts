// CLI helper: backfill assets.shutter_count for a library indexed BEFORE the
// column existed — without re-reading the whole NAS. The gear page only shows
// the MAX per body (the odometer's last known reading, cf. lib/gear.ts), and
// the counter is monotone with capture time, so re-reading just the newest few
// photos of each body is enough to light the card up. New ingests keep the
// value current from then on (cf. lib/extract.ts / lib/indexer.ts).
//
// Every body is tried, not just Sony: the composite ShutterCount tag also
// exists on other makers, and a body that carries no tag costs N wasted reads
// exactly once. A frame whose file is gone or unreadable is simply skipped —
// this is an opportunistic sweep, not an integrity pass.
//
// Usage:
//   npm run shutter-backfill                     # newest 10 photos per body
//   npm run shutter-backfill -- --per-device 25  # dig deeper per body
//   npm run shutter-backfill -- --all            # every photo still NULL (slow:
//                                                # one exiftool read per file)
import { many, q, pool } from "../lib/db";
import { closeExiftool, readShutterCount } from "../lib/extract";

function argInt(flag: string, dflt: number): number {
  const i = process.argv.indexOf(flag);
  const n = i >= 0 ? Number.parseInt(process.argv[i + 1] ?? "", 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

async function main() {
  const all = process.argv.includes("--all");
  const perDevice = argInt("--per-device", 10);

  // Live photos only: video files never carry the counter, and a trashed frame
  // shouldn't be the reading the shelf reports. Newest first WITHIN each body —
  // the max lives at the recent end, so that's where the few reads go.
  const rows = await many<{ id: number; abs_path: string; device: string }>(
    all
      ? `SELECT id, abs_path, device FROM assets
           WHERE media_type = 'photo' AND deleted_at IS NULL
             AND shutter_count IS NULL
             AND device IS NOT NULL AND device <> ''
           ORDER BY device, captured_at DESC`
      : `SELECT id, abs_path, device FROM (
           SELECT id, abs_path, device,
                  row_number() OVER (
                    PARTITION BY device
                    ORDER BY captured_at DESC NULLS LAST, id DESC
                  ) AS rn
             FROM assets
            WHERE media_type = 'photo' AND deleted_at IS NULL
              AND shutter_count IS NULL
              AND device IS NOT NULL AND device <> ''
         ) recent
         WHERE rn <= ${perDevice}
         ORDER BY device, rn`,
  );

  console.log(
    `Reading ${rows.length} file(s)${all ? "" : ` (newest ${perDevice} per body)`}…`,
  );
  let read = 0;
  let found = 0;
  const perBody = new Map<string, number>();
  for (const r of rows) {
    let count: number | null = null;
    try {
      count = await readShutterCount(r.abs_path);
    } catch (err) {
      console.warn(`  skip ${r.abs_path}: ${(err as Error).message}`);
      continue;
    }
    read++;
    if (count == null) continue;
    await q("UPDATE assets SET shutter_count = $1 WHERE id = $2", [count, r.id]);
    found++;
    const prev = perBody.get(r.device);
    if (prev == null || count > prev) perBody.set(r.device, count);
    if (read % 100 === 0) console.log(`  read ${read}/${rows.length}`);
  }

  console.log(`Done. ${read} file(s) read, ${found} carried a shutter count.`);
  for (const [device, max] of [...perBody.entries()].sort())
    console.log(`  ${device}: ${max.toLocaleString()} actuations`);
  if (perBody.size === 0)
    console.log("  No body exposed the tag (expected for phones/drones).");

  await closeExiftool();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
