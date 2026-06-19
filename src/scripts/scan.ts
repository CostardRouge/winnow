// CLI helper: registers a root (if it doesn't exist) and starts an indexing run.
// Usage: npm run scan -- /path/to/NAS/folder [--sync]
//   --sync: indexes directly in this process (without going through Redis/worker)
import { one } from "../lib/db";
import { pool } from "../lib/db";
import { enqueueIndex } from "../lib/queue";
import { indexRoot } from "../lib/indexer";
import { closeExiftool } from "../lib/extract";
import path from "node:path";

async function main() {
  const args = process.argv.slice(2);
  const sync = args.includes("--sync");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("Usage: npm run scan -- /path/to/folder [--sync]");
    process.exit(1);
  }
  const abs = path.resolve(target);

  const root = await one<{ id: number }>(
    `INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', true)
     ON CONFLICT (path) DO UPDATE SET path = EXCLUDED.path
     RETURNING id`,
    [abs],
  );

  if (sync) {
    console.log(`Synchronous indexing of ${abs}…`);
    const res = await indexRoot(root!.id);
    console.log(res);
    await closeExiftool();
  } else {
    await enqueueIndex(root!.id);
    console.log(`Indexing queued for root ${root!.id} (${abs}).`);
    console.log("Run `npm run worker` to process it.");
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
