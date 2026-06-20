// CLI helper: registers a root (if it doesn't exist) and starts an indexing run.
// Usage: npm run scan -- /path/to/NAS/folder [--sync]
//   --sync: indexes directly in this process (without going through Redis/worker)
import { one } from "../lib/db";
import { pool } from "../lib/db";
import { enqueueIndex } from "../lib/queue";
import { indexRoot } from "../lib/indexer";
import { closeExiftool } from "../lib/extract";
import { createLogger } from "../lib/log";
import path from "node:path";

const log = createLogger("scan");

async function main() {
  const args = process.argv.slice(2);
  const sync = args.includes("--sync");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    log.error("usage: npm run scan -- /path/to/folder [--sync]");
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
    log.info("synchronous indexing", { path: abs });
    const res = await indexRoot(root!.id);
    log.info("indexing complete", { path: abs, ...res });
    await closeExiftool();
  } else {
    await enqueueIndex(root!.id);
    log.info("indexing queued — run `npm run worker` to process it", {
      rootId: root!.id,
      path: abs,
    });
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error("scan failed", { err });
  process.exit(1);
});
