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
  acquireScanLock,
  releaseScanLock,
  nextWaitingIndexPriority,
  type IndexJob,
  type DerivativeJob,
  type ExportJob,
  type ImportJob,
  type PurgeJob,
  type GeocodeJob,
  type MlJob,
  type IntegrityJob,
} from "./lib/queue";
import { indexRoot } from "./lib/indexer";
import { runIntegrityJob } from "./lib/integrity";
import { generateDerivative } from "./lib/derivatives";
import { runExportJob } from "./lib/export";
import { runPurgeJob } from "./lib/purge";
import { runImport } from "./lib/import";
import { runGeocodeJob } from "./lib/geocode";
import { runMlJob } from "./lib/ml";
import { bootstrapRoots } from "./lib/bootstrap";
import { startInboxWatcher } from "./lib/watcher";
import { closeExiftool } from "./lib/extract";
import { getSettings } from "./lib/settings";
import { reserveSlot, sleep } from "./lib/rate";
import { one, many } from "./lib/db";
import { dedupeOverlappingRoots } from "./lib/volumes";

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

    // Single-flight per root: if a scan of this root is already running (another
    // replica, or a follow-up job that stacked while this one was active and
    // SCAN_CONCURRENCY > 1), skip rather than walk the same tree twice. Two
    // concurrent walks race the content_hash INSERT and log files as duplicates
    // of themselves; the periodic rescan re-enqueues, so nothing is lost.
    const lockToken = await acquireScanLock(rootId);
    if (!lockToken) {
      console.log(`[index] root ${rootId} already scanning — skipping duplicate job`);
      return { skipped: true as const };
    }
    console.log(`[index] root ${rootId}…`);

    try {
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
    } finally {
      await releaseScanLock(rootId, lockToken);
    }
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

// Purge: physically removes the trashed originals + derivatives to reclaim NAS
// space. Bounded concurrency (defaults to 1) to spare the full HDD.
const purgeWorker = new Worker(
  QUEUES.purge,
  async (job) => {
    const { purgeJobId } = job.data as PurgeJob;
    console.log(`[purge] job ${purgeJobId}…`);
    await runPurgeJob(purgeJobId);
  },
  { connection, concurrency: config.purgeConcurrency },
);

// Reverse geocoding: resolves GPS coordinates to place names (cf. lib/geocode.ts).
// Concurrency defaults to 1 and the network call is drip-fed by the per-hour rate
// setting, so this stays within a free provider's limits. A cached cell makes no
// call at all, so most jobs are pure DB writes.
const geocodeWorker = new Worker(
  QUEUES.geocode,
  async (job) => {
    const { assetId, precise } = job.data as GeocodeJob;
    await runGeocodeJob(assetId, { precise });
  },
  { connection, concurrency: config.geocode.concurrency },
);

// ML analysis (faces + OCR, cf. lib/ml.ts): sends the existing derivative to the
// immich-machine-learning container. Concurrency defaults to 1 (the container
// queues without backpressure) and the call is drip-fed by mlPerHour, so the
// 80k backfill never pins the box.
const mlWorker = new Worker(
  QUEUES.ml,
  async (job) => {
    await runMlJob((job.data as MlJob).assetId);
  },
  { connection, concurrency: config.ml.concurrency },
);

// Integrity sweep (cf. lib/integrity.ts): re-stats every live original and
// verifies the derivative objects still exist in storage. Serialized (one
// sweep at a time) — it's the scan's I/O profile, so it must never gang up
// on the NAS HDD.
const integrityWorker = new Worker(
  QUEUES.integrity,
  async (job) => {
    const { rootId } = job.data as IntegrityJob;
    console.log(`[integrity] sweep${rootId ? ` (root ${rootId})` : ""}…`);
    return runIntegrityJob({ rootId });
  },
  { connection, concurrency: 1 },
);

for (const [name, w] of [
  ["index", indexWorker],
  ["derivatives", derivativeWorker],
  ["export", exportWorker],
  ["import", importWorker],
  ["purge", purgeWorker],
  ["geocode", geocodeWorker],
  ["ml", mlWorker],
  ["integrity", integrityWorker],
] as const) {
  w.on("failed", (job, err) =>
    console.error(`[${name}] job ${job?.id} failed:`, err.message),
  );
}

// Register + (re)index the known roots (incoming + configured final
// folders) at startup, without blocking the workers' loop.
void bootstrapRoots();

// Periodic re-scan. There is no filesystem watcher on the NAS mounts (inotify
// doesn't propagate over SMB/NFS), so without this the library only notices
// on-disk changes at worker startup or on a manual re-index. The interval is a
// live setting (`rescanMinutes`, Pipeline page; 0 = off): every due tick
// re-enqueues an incremental scan of each watched root — cheap on unchanged
// files (stat-only), and enqueueIndex coalesces so ticks can never stack jobs.
// The end-of-scan missing-file pass rides along, so deletions are noticed on
// the same cadence. First tick counts from process start: bootstrap already
// scanned everything at boot.
let lastPeriodicScan = Date.now();
const periodicScanTimer = setInterval(async () => {
  try {
    const { rescanMinutes, scanPaused } = await getSettings();
    if (rescanMinutes <= 0 || scanPaused) return;
    if (Date.now() - lastPeriodicScan < rescanMinutes * 60_000) return;
    lastPeriodicScan = Date.now();
    const watched = await many<{ id: number; path: string }>(
      "SELECT id, path FROM roots WHERE kind IN ('source','finals') AND watch = true",
    );
    // Never scan two overlapping roots — the nested one's files are already
    // walked by its container, and doing both double-indexes every shared file.
    const { kept: roots, dropped } = dedupeOverlappingRoots(watched);
    for (const d of dropped)
      console.warn(
        `[rescan] "${d.root.path}" overlaps "${d.coveredBy.path}" — skipped (already covered); remove the nested volume to silence this`,
      );
    for (const r of roots) {
      await enqueueIndex(r.id, {
        priority:
          r.path === config.import.incomingDir ? PRIORITY.high : PRIORITY.normal,
      });
    }
    if (roots.length)
      console.log(`[rescan] periodic tick: ${roots.length} root(s) re-enqueued`);
  } catch (err) {
    console.error("[rescan] periodic tick failed:", (err as Error).message);
  }
}, 60_000);
periodicScanTimer.unref?.();

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
  clearInterval(periodicScanTimer);
  if (stopWatcher) await stopWatcher();
  await Promise.allSettled([
    indexWorker.close(),
    derivativeWorker.close(),
    exportWorker.close(),
    importWorker.close(),
    purgeWorker.close(),
    geocodeWorker.close(),
    mlWorker.close(),
    integrityWorker.close(),
  ]);
  await closeExiftool();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
