// CLI helper: file every frame on its photographer's LOCAL day (migration
// 0046). The counterpart of Settings › Pipeline › Dates & places — the button
// is the interface (docs/memory: a repair needing SSH does not exist), this is
// for a dev box. Thin wrapper over lib/captureDays.ts.
//
// Usage:
//   npm run capture-days                     # preview: rolled back, prints the report
//   npm run capture-days -- --apply          # database-only repair
//   npm run capture-days -- --apply --reread # also re-read unclassified files' date tags
import { pool } from "../lib/db";
import { runCaptureDayBackfill } from "../lib/captureDays";
import { closeExiftool } from "../lib/extract";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const reread = apply && args.includes("--reread");
  console.log(apply ? (reread ? "Repairing + re-reading dates…" : "Repairing…") : "Preview (nothing written)…");
  const r = await runCaptureDayBackfill({ apply, reread });
  console.log(JSON.stringify(r, null, 2));
  await closeExiftool();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
