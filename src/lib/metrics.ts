// Minimal Prometheus metrics registry (zero-dependency). Gives a 24/7 deployment
// the basics asked for in review §5: scan/derivative/import throughput, queue
// depth and failure rate.
//
// Two kinds of series:
//   - in-process counters/histograms, incremented where the work happens (the
//     worker process: indexer, derivatives, importer);
//   - live gauges (queue depth, asset state, outstanding failures) sampled from
//     Postgres/Redis at scrape time via collectLiveGauges().
//
// Exposed by the worker on its own HTTP port and by the app at /api/metrics.
// Throughput is a monotonic counter on purpose — let Prometheus derive the rate
// (e.g. rate(winnow_scan_files_total[5m])).
import { one } from "./db";
import { getQueueStats } from "./queue";

type Labels = Record<string, string>;

interface Metric {
  render(): string;
}

const registry: Metric[] = [];

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelStr(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(",")}}`;
}

class Counter implements Metric {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {
    registry.push(this);
  }
  inc(labels: Labels = {}, value = 1): void {
    if (value < 0) return; // counters only ever go up
    const key = labelStr(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += value;
    else this.values.set(key, { labels, value });
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${labelStr(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

class Gauge implements Metric {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {
    registry.push(this);
  }
  set(labels: Labels, value: number): void {
    this.values.set(labelStr(labels), { labels, value });
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${labelStr(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

// Buckets tuned for file work: from sub-second derivatives to minutes-long
// video transcodes / large scans.
const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

class Histogram implements Metric {
  private series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
    readonly buckets: number[] = DEFAULT_BUCKETS,
  ) {
    registry.push(this);
  }
  observe(labels: Labels, value: number): void {
    const key = labelStr(labels);
    let s = this.series.get(key);
    if (!s) {
      s = {
        labels,
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    // counts[i] holds the cumulative "<= buckets[i]" count Prometheus expects:
    // a single observation bumps every bucket whose boundary is >= the value.
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${labelStr({ ...s.labels, le: String(this.buckets[i]) })} ${s.counts[i]}`,
        );
      }
      lines.push(
        `${this.name}_bucket${labelStr({ ...s.labels, le: "+Inf" })} ${s.count}`,
      );
      lines.push(`${this.name}_sum${labelStr(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${labelStr(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

export const metrics = {
  scanFiles: new Counter(
    "winnow_scan_files_total",
    "Files processed by the indexer, by outcome.",
    ["result"],
  ),
  scanRuns: new Counter(
    "winnow_scan_runs_total",
    "Indexing runs, by outcome (completed|stopped).",
    ["outcome"],
  ),
  scanDuration: new Histogram(
    "winnow_scan_duration_seconds",
    "Duration of an indexing run.",
  ),
  derivatives: new Counter(
    "winnow_derivatives_total",
    "Derivatives generated, by media type and outcome.",
    ["media_type", "result"],
  ),
  derivativeDuration: new Histogram(
    "winnow_derivative_duration_seconds",
    "Duration of a derivative generation.",
    ["media_type"],
  ),
  importFiles: new Counter(
    "winnow_import_files_total",
    "Files processed by the importer, by outcome.",
    ["result"],
  ),
  jobsFailed: new Counter(
    "winnow_jobs_failed_total",
    "BullMQ jobs that ended in failure, by queue.",
    ["queue"],
  ),
  queueJobs: new Gauge(
    "winnow_queue_jobs",
    "Jobs currently in a queue, by queue and state.",
    ["queue", "state"],
  ),
  assets: new Gauge(
    "winnow_assets",
    "Indexed assets, by state.",
    ["state"],
  ),
  failures: new Gauge(
    "winnow_failures",
    "Outstanding (unresolved) failures, by kind.",
    ["kind"],
  ),
  scanPaused: new Gauge(
    "winnow_scan_paused",
    "Pipeline paused (1) or running (0).",
  ),
  up: new Gauge("winnow_up", "Process liveness (1 = up), by component.", [
    "component",
  ]),
};

// Prometheus exposition (text format 0.0.4).
export function render(): string {
  return registry.map((m) => m.render()).join("\n\n") + "\n";
}

// Sample the gauges that describe current state (queue depth, asset counts,
// outstanding failures) from Redis/Postgres. Each source is isolated so a Redis
// outage still yields the DB gauges (and vice versa) — the endpoint never 500s.
export async function collectLiveGauges(): Promise<void> {
  try {
    const qs = await getQueueStats();
    const byQueue: Record<string, Record<string, number>> = {
      scan: qs.scan,
      analyze: qs.analyze,
      import: qs.import,
    };
    for (const [queue, counts] of Object.entries(byQueue)) {
      for (const [state, n] of Object.entries(counts)) {
        metrics.queueJobs.set({ queue, state }, Number(n) || 0);
      }
    }
    metrics.scanPaused.set({}, qs.paused ? 1 : 0);
  } catch {
    /* Redis unavailable: keep the last sampled values */
  }

  try {
    const a = await one<{
      total: number;
      photos: number;
      videos: number;
      ready: number;
      pending: number;
      error: number;
      skipped: number;
    }>(
      `SELECT
         count(*)                                                              AS total,
         count(*) FILTER (WHERE media_type = 'photo')                          AS photos,
         count(*) FILTER (WHERE media_type = 'video')                          AS videos,
         count(*) FILTER (WHERE derivative_status = 'ready')                   AS ready,
         count(*) FILTER (WHERE derivative_status IN ('pending','processing')) AS pending,
         count(*) FILTER (WHERE derivative_status = 'error')                   AS error,
         count(*) FILTER (WHERE derivative_status = 'skipped')                 AS skipped
       FROM assets`,
    );
    if (a) {
      metrics.assets.set({ state: "total" }, Number(a.total) || 0);
      metrics.assets.set({ state: "photo" }, Number(a.photos) || 0);
      metrics.assets.set({ state: "video" }, Number(a.videos) || 0);
      metrics.assets.set({ state: "ready" }, Number(a.ready) || 0);
      metrics.assets.set({ state: "pending" }, Number(a.pending) || 0);
      metrics.assets.set({ state: "error" }, Number(a.error) || 0);
      metrics.assets.set({ state: "skipped" }, Number(a.skipped) || 0);
    }
  } catch {
    /* tables absent before migration / Postgres unavailable */
  }

  try {
    const f = await one<{ scan: number; imp: number; derivative: number }>(
      `SELECT
         (SELECT count(*) FROM scan_failures WHERE resolved_at IS NULL)         AS scan,
         (SELECT COALESCE(sum(failed), 0) FROM import_batches WHERE failed > 0) AS imp,
         (SELECT count(*) FROM assets WHERE derivative_status = 'error')        AS derivative`,
    );
    if (f) {
      metrics.failures.set({ kind: "scan" }, Number(f.scan) || 0);
      metrics.failures.set({ kind: "import" }, Number(f.imp) || 0);
      metrics.failures.set({ kind: "derivative" }, Number(f.derivative) || 0);
    }
  } catch {
    /* tables absent before migration / Postgres unavailable */
  }
}
