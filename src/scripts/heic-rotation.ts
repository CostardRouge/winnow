// CLI helper: finds HEIC/HEIF assets whose existing derivatives were rotated
// twice by the pre-fix worker, and (optionally) re-queues them for regeneration.
//
// Background: libheif (heic-convert) applies the HEIF container transform
// (irot/imir) when decoding and ignores EXIF, but the old worker ALSO re-applied
// the EXIF Orientation on top. An asset was double-rotated iff its file carries
// BOTH a container transform AND an EXIF Orientation that maps to a real angle
// (3=180°, 6=90°, 8=270°). Those are the thumbnails/proxies that look sideways
// or upside-down. The fix only changes generation, so already-built derivatives
// must be regenerated — this script identifies and (with --fix) re-queues them.
//
// Usage:
//   npx tsx src/scripts/heic-rotation.ts          # dry run: just list them
//   npx tsx src/scripts/heic-rotation.ts --fix    # reset to pending + re-queue
import { many, q, pool } from "../lib/db";
import { enqueueDerivative } from "../lib/queue";
import { closeExiftool, readHeicOrientation } from "../lib/extract";
import { HEIC_EXTS } from "../lib/config";
import { stat } from "node:fs/promises";

// EXIF orientations the worker actually rotated for (cf. ORIENTATION_ANGLE in
// derivatives.ts). 1/2/4/5/7 produced a 0° angle, so they were never affected.
const ROTATING = new Set([3, 6, 8]);

type Row = { id: number; abs_path: string; ext: string };

async function main() {
  const fix = process.argv.includes("--fix");
  const exts = [...HEIC_EXTS];

  const rows = await many<Row>(
    `SELECT id, abs_path, ext
       FROM assets
      WHERE deleted_at IS NULL
        AND media_type = 'photo'
        AND lower(ext) = ANY($1)
        AND derivative_status = 'ready'
      ORDER BY id`,
    [exts],
  );

  console.log(`Scanning ${rows.length} ready HEIC/HEIF asset(s)…\n`);

  const affected: number[] = [];
  let missing = 0;

  for (const r of rows) {
    // Skip files that are currently offline (NAS unmounted, etc.) rather than
    // guessing — they simply aren't evaluated this run.
    try {
      await stat(r.abs_path);
    } catch {
      missing++;
      continue;
    }
    const { exif, containerRotated } = await readHeicOrientation(r.abs_path);
    if (containerRotated && exif !== undefined && ROTATING.has(exif)) {
      affected.push(r.id);
      console.log(`  bad  #${r.id}  (irot + EXIF orientation ${exif})  ${r.abs_path}`);
    }
  }

  console.log(
    `\n${affected.length} affected, ${missing} skipped (file not reachable), ` +
      `${rows.length - affected.length - missing} OK.`,
  );

  if (!affected.length) {
    console.log("Nothing to do.");
  } else if (!fix) {
    console.log("\nDry run — re-run with --fix to reset these to 'pending' and re-queue them.");
  } else {
    await q(
      "UPDATE assets SET derivative_status='pending', derivative_error=NULL, updated_at=now() WHERE id = ANY($1)",
      [affected],
    );
    for (const id of affected) await enqueueDerivative(id);
    console.log(`\nRe-queued ${affected.length} asset(s). Run \`npm run worker\` to rebuild them.`);
  }

  await closeExiftool();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
