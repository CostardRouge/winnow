// CLI helper: finds HEIC/HEIF assets whose existing derivatives were rotated
// twice by the pre-fix worker, and (optionally) re-queues them for regeneration.
//
// An asset was double-rotated iff its original carries BOTH a container transform
// (irot) AND an EXIF Orientation that maps to a real angle (3=180°, 6=90°,
// 8=270°). Detection logic is shared with the Pipeline UI (see lib/heicRotation).
//
// Usage:
//   npx tsx src/scripts/heic-rotation.ts          # dry run: just list them
//   npx tsx src/scripts/heic-rotation.ts --fix    # reset to pending + re-queue
import { q, pool } from "../lib/db";
import { enqueueDerivative } from "../lib/queue";
import { closeExiftool } from "../lib/extract";
import { scanHeicRotation } from "../lib/heicRotation";

async function main() {
  const fix = process.argv.includes("--fix");

  const { scanned, missing, affected } = await scanHeicRotation();
  console.log(`Scanned ${scanned} ready HEIC/HEIF asset(s).\n`);

  for (const a of affected) {
    console.log(
      `  bad  #${a.id}  (irot + EXIF orientation ${a.orientation})  ${a.abs_path}`,
    );
  }

  console.log(
    `\n${affected.length} affected, ${missing} skipped (file not reachable), ` +
      `${scanned - affected.length - missing} OK.`,
  );

  if (!affected.length) {
    console.log("Nothing to do.");
  } else if (!fix) {
    console.log(
      "\nDry run — re-run with --fix to reset these to 'pending' and re-queue them.",
    );
  } else {
    const ids = affected.map((a) => a.id);
    await q(
      "UPDATE assets SET derivative_status='pending', derivative_error=NULL, updated_at=now() WHERE id = ANY($1)",
      [ids],
    );
    for (const id of ids) await enqueueDerivative(id);
    console.log(
      `\nRe-queued ${ids.length} asset(s). Run \`npm run worker\` to rebuild them.`,
    );
  }

  await closeExiftool();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
