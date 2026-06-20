// Entry point for the BullMQ workers (cf. §3).
// Bounded concurrency to spare the NAS's full HDD and the Optiplex.
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

console.log("Winnow workers — starting up");
console.log(`  storage : ${config.storage.driver}`);
console.log(`  derivative concurrency : ${config.derivativeConcurrency}`);

// Last-resort process guards. A single malformed media file — a corrupt HEIF
// that faults inside libheif's WASM, an unexpected async throw from a decode
// library — must NEVER take the whole worker down: otherwise photo, RAW AND
// video derivatives all stop at once. BullMQ already records per-job failures;
// here we only log and keep the worker running.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException (kept alive):", err);
});

const indexWorker = new Worker(
  QUEUES.index,
  async (job) => {
    const { rootId } = job.data as IndexJob;
    const myPriority = job.opts.priority ?? PRIORITY.normal;
    console.log(`[index] root ${rootId}…`);

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
    console.log(`[index] done`, res);

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
    console.log(`[export] job ${exportJobId}…`);
    await runExportJob(exportJobId);
  },
  { connection, concurrency: config.exportConcurrency },
);

const importWorker = new Worker(
  QUEUES.import,
  async (job) => {
    const data = job.data as ImportJob;
    console.log(`[import] ${data.origin} ← ${data.sourceDir}`);
    const res = await runImport(data);
    console.log(`[import] done`, res);
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
  w.on("failed", (job, err) =>
    console.error(`[${name}] job ${job?.id} failed:`, err.message),
  );
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
  console.log("Stopping the workers…");
  if (stopWatcher) await stopWatcher();
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
