// GET /api/health → sonde de vivacité (utilisée par le healthcheck Docker).
// Vérifie que l'app répond, que Postgres est joignable et que Redis répond.
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
