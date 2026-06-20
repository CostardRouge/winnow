// GET /api/metrics (also reachable at /metrics via a rewrite) → Prometheus
// exposition for the app process. Surfaces the live gauges sampled from
// Postgres/Redis (queue depth, asset state, outstanding failures); the
// pipeline throughput/duration counters live in the worker process and are
// scraped from its own /metrics port (see src/worker.ts). Reachable behind the
// existing Traefik proxy.
import { collectLiveGauges, metrics, render } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  metrics.up.set({ component: "app" }, 1);
  await collectLiveGauges();
  return new Response(render(), {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
