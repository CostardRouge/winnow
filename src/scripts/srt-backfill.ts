// CLI helper: parse the telemetry of DJI .SRT sidecars already indexed as opaque
// companions (before lib/srt.ts existed, or imported by an older build). Thin
// wrapper over lib/srtBackfill.ts (shared with the Pipeline UI action); no NAS
// re-scan needed — the sidecars are already recorded. Idempotent.
//
// Usage:
//   npm run srt-backfill              # only .srt not yet parsed (sample_count NULL)
//   npm run srt-backfill -- --force   # re-parse every .srt (e.g. after a parser fix)
// Then run `npm run worker` (or leave it running) to drain any geocode jobs.
import { pool } from "../lib/db";
import { runSrtBackfill } from "../lib/srtBackfill";

async function main() {
  const force = process.argv.slice(2).includes("--force");
  console.log(`Parsing DJI .SRT sidecars${force ? " (force: re-parse all)" : ""}…`);

  const r = await runSrtBackfill({ force });
  console.log(
    `Done. Scanned ${r.scanned}, parsed ${r.parsed}, backfilled location for ` +
      `${r.located} clip(s), queued ${r.geocoded} geocode job(s). ` +
      "Run `npm run worker` to process them.",
  );

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
