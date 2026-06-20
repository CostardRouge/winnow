// Entry point for the BullMQ workers (cf. §3).
// Bounded concurrency to spare the NAS's full HDD and the Optiplex.
import { createServer, type Server } from "node:http";
import { Worker } from "bullmq";
import { config } from "./lib/config";
import {
  connection,
  QUEUES,
  PRIORITY,
  enqueueImport,
  enqueueIndex,
  nextWaitingIndexPriority,
  type IndexJob,
  type DerivativeJob,
  type ExportJob,
  type ImportJob,
} from "./lib/queue";
import { indexRoot } from "./lib/indexer";
import { generateDerivative } from "./lib/derivatives";
import { runExportJob } from "./lib/export";
import { runImport } from "./lib/import";
import { bootstrapRoots } from "./lib/bootstrap";
import { startInboxWatcher } from "./lib/watcher";
import { closeExiftool } from "./lib/extract";
import { getSettings } from "./lib/settings";
import { reserveSlot, sleep } from "./lib/rate";
import { one } from "./lib/db";
import { createLogger } from "./lib/log";
import { collectLiveGauges, metrics, render } from "./lib/metrics";

const log = createLogger("worker");
metrics.up.set({ component: "worker" }, 1);

log.info("workers starting up", {
  storage: config.storage.driver,
  scanConcurrency: config.scanConcurrency,
  derivativeConcurrency: config.derivativeConcurrency,
  exportConcurrency: config.exportConcurrency,
  importConcurrency: config.import.concurrency,
});

// Prometheus scrape endpoint for the worker process: the pipeline throughput,
// duration and failure counters live here (this is where the work happens), so
// this is the canonical target. Also serves /healthz for orchestration.
const metricsServer: Server | null = config.metrics.enabled
  ? createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      if (path === "/metrics") {
        collectLiveGauges()
          .catch(() => {})
          .finally(() => {
            res.writeHead(200, {
              "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            });
            res.end(render());
          });
        return;
      }
      if (path === "/healthz" || path === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404).end();
    })
  : null;
metricsServer?.listen(config.metrics.port, () =>
  log.info("metrics endpoint listening", { port: config.metrics.port }),
);

const indexWorker = new Worker(
  QUEUES.index,
  async (job) => {
    const { rootId } = job.data as IndexJob;
    const myPriority = job.opts.priority ?? PRIORITY.normal;
    log.info("indexing root", { rootId, priority: myPriority });

    // Preemption: an ordinary scan yields as soon as a higher-priority
    // scan (incoming/inbox) is waiting. The result is cached for 2 s
    // to bound Redis calls on large trees.
    let preempt = { at: 0, value: false };
    const higherWaiting = async () => {
      const now = Date.now();
      if (now - preempt.at > 2000) {
        const next = await nextWaitingIndexPriority();
        preempt = { at: now, value: next != null && next < myPriority };
      }
      return preempt.value;
    };

    const res = await indexRoot(rootId, {
      shouldStop: async () => {
        if ((await getSettings()).scanPaused) return true;
        return higherWaiting();
      },
      throttle: async () => {
        const { scanPerHour } = await getSettings();
        if (scanPerHour <= 0) return;
        // Drip-feed: wait for the next slot, periodically re-checking
        // the pause/preemption state to stay responsive.
        let wait = await reserveSlot("scan", scanPerHour);
        while (wait > 0) {
          await sleep(Math.min(wait, 3000));
          if ((await getSettings()).scanPaused || (await higherWaiting())) return;
          wait = await reserveSlot("scan", scanPerHour);
        }
      },
    });
    log.info("indexing done", { rootId, ...res });

    // Interrupted by preemption (not by pause): re-enqueue the root to
    // resume incremental indexing once the higher-priority work is drained.
    if (res.stopped && !(await getSettings()).scanPaused) {
      await enqueueIndex(rootId, { priority: myPriority });
    }
    return res;
  },
  { connection, concurrency: config.scanConcurrency },
);

const derivativeWorker: Worker = new Worker(
  QUEUES.derivatives,
  async (job) => {
    // Smoothing of the analysis rate (derivatives). Above quota, we rate-limit
    // the whole worker until the next slot and put the job back in the queue
    // (without counting it as a failure): priority derivatives will go back to the front.
    const { analyzePerHour } = await getSettings();
    if (analyzePerHour > 0) {
      const wait = await reserveSlot("analyze", analyzePerHour);
      if (wait > 0) {
        await derivativeWorker.rateLimit(wait);
        throw Worker.RateLimitError();
      }
    }
    await generateDerivative((job.data as DerivativeJob).assetId);
  },
  { connection, concurrency: config.derivativeConcurrency },
);

const exportWorker = new Worker(
  QUEUES.export,
  async (job) => {
    const { exportJobId } = job.data as ExportJob;
    log.info("export job", { exportJobId });
    await runExportJob(exportJobId);
  },
  { connection, concurrency: config.exportConcurrency },
);

const importWorker = new Worker(
  QUEUES.import,
  async (job) => {
    const data = job.data as ImportJob;
    log.info("import starting", { origin: data.origin, sourceDir: data.sourceDir });
    const res = await runImport(data);
    log.info("import done", {
      origin: data.origin,
      imported: res.imported,
      duplicates: res.duplicates,
      failed: res.failed,
    });
    return res;
  },
  { connection, concurrency: config.import.concurrency },
);

for (const [name, w] of [
  ["index", indexWorker],
  ["derivatives", derivativeWorker],
  ["export", exportWorker],
  ["import", importWorker],
] as const) {
  w.on("failed", (job, err) => {
    metrics.jobsFailed.inc({ queue: name });
    log.error("job failed", { queue: name, jobId: job?.id, err });
  });
}

// Register + (re)index the known roots (incoming + configured final
// folders) at startup, without blocking the workers' loop.
void bootstrapRoots();

// Inbox watching: SMB / FTP drops → automatic import. We create a
// batch so these passive imports are visible/tracked like the others.
const stopWatcher = config.import.watchInbox
  ? startInboxWatcher(config.import.inboxDir, async (sourceDir) => {
      const batch = await one<{ id: number }>(
        "INSERT INTO import_batches (source_dir, origin) VALUES ($1, 'inbox') RETURNING id",
        [sourceDir],
      );
      return enqueueImport({
        sourceDir,
        origin: "inbox",
        removeAfter: true,
        batchId: batch?.id,
      });
    })
  : null;

async function shutdown() {
  log.info("stopping the workers");
  if (stopWatcher) await stopWatcher();
  metricsServer?.close();
  await Promise.allSettled([
    indexWorker.close(),
    derivativeWorker.close(),
    exportWorker.close(),
    importWorker.close(),
  ]);
  await closeExiftool();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
