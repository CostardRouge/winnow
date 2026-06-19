// GET /api/health → liveness probe (used by the Docker healthcheck).
// Checks that the app responds, that Postgres is reachable and that Redis responds.
import { q } from "@/lib/db";
import { pingRedis } from "@/lib/queue";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const [db, redis] = await Promise.all([
    q("SELECT 1")
      .then(() => true)
      .catch(() => false),
    pingRedis(),
  ]);
  const ok = db && redis;
  return json(
    {
      status: ok ? "ok" : "degraded",
      db: db ? "up" : "down",
      redis: redis ? "up" : "down",
    },
    ok ? 200 : 503,
  );
}
