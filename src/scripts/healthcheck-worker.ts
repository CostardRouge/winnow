// Liveness probe for the BullMQ worker container.
//
// The worker runs no HTTP server, so it can't reuse the app's /api/health
// route. Yet it inherits the image-level Docker HEALTHCHECK (Dockerfile), which
// fetches http://127.0.0.1:3000/api/health — a port nothing listens on inside
// the worker. That probe therefore ALWAYS fails and Docker/Portainer flags the
// worker "unhealthy" even while it is happily draining jobs. The worker service
// overrides that probe (docker-compose*.yml) to run THIS script instead.
//
// What "healthy" means for a queue worker: it can reach the two backends it
// needs to pull and process jobs — Redis (the queue) and Postgres (the source
// of truth). We reuse the exact helpers the app's health route uses so the two
// probes stay in lockstep. Exit 0 = healthy, exit 1 = unhealthy.
import { pingRedis } from "../lib/queue";
import { q } from "../lib/db";

// Hard ceiling below the compose `timeout` so we ALWAYS exit with a verdict
// rather than letting Docker kill us on timeout (which also counts as a fail,
// but a clean exit keeps the logs readable).
const DEADLINE_MS = 4000;

async function main(): Promise<number> {
  const [db, redis] = await Promise.all([
    q("SELECT 1")
      .then(() => true)
      .catch(() => false),
    pingRedis(),
  ]);
  if (!redis) console.error("[healthcheck] redis: down");
  if (!db) console.error("[healthcheck] postgres: down");
  return db && redis ? 0 : 1;
}

const timer = setTimeout(() => {
  console.error("[healthcheck] timed out");
  process.exit(1);
}, DEADLINE_MS);
timer.unref();

main()
  // The Redis singleton and the pg pool keep the event loop alive, so exit
  // explicitly once we have a verdict instead of waiting for them to drain.
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[healthcheck] error:", err);
    process.exit(1);
  });
