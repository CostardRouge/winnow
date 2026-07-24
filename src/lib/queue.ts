// Redis queues (BullMQ). Three decoupled queues (cf. §3):
//  - index       : incremental scan of a root
//  - derivatives : thumbnail + proxy generation
//  - export      : export jobs (RAW copy for C1, etc.)
import { Queue, type ConnectionOptions, type Job } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

// BullMQ bundles its own copy of ioredis; we share one instance and
// neutralize the nominal type conflict with a cast at the boundary.
const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  // No connection until a command is issued (avoids attempts
  // at build/import time when Redis is unreachable).
  lazyConnect: true,
});
export const connection = redis as unknown as ConnectionOptions;

// Raw ioredis client, reused by the rate limiter (Lua scripts).
export const redisClient = redis;

// BullMQ priorities: the smaller the number, the higher the priority
// (0 = highest). We use `high` < `normal` to put the incoming
// and the inbox ahead of ordinary scans/derivatives.
export const PRIORITY = { high: 1, normal: 10 } as const;

// Redis liveness probe for the healthcheck (fast failure via timeout).
export async function pingRedis(timeoutMs = 3000): Promise<boolean> {
  try {
    const ping = redis.ping();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("redis ping timeout")), timeoutMs),
    );
    await Promise.race([ping, timeout]);
    return true;
  } catch {
    return false;
  }
}

// --- Per-root scan lock -----------------------------------------------------
// Guarantees a single in-flight scan per root across every worker/replica, even
// when SCAN_CONCURRENCY > 1 or a periodic rescan tick queues a follow-up while
// one is still active (`active` is deliberately excluded from coalescing, see
// PENDING_INDEX_STATES — so nothing else stops two jobs for the same root from
// running at once). Two concurrent scans of the same tree walk identical paths
// and race the content_hash INSERT, logging files as duplicates of themselves.
// The lock serializes them; a skipped follow-up is harmless because the next
// rescan tick re-enqueues once the walk is free. The TTL is a safety net so a
// crashed holder can't wedge a root forever.
const SCAN_LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6h — longer than any single scan
let scanLockSeq = 0;

// Try to claim the scan slot for a root. Returns an opaque owner token on
// success (pass it back to releaseScanLock), or null if a scan already holds it.
export async function acquireScanLock(rootId: number): Promise<string | null> {
  const token = `${process.pid}-${Date.now()}-${scanLockSeq++}`;
  const ok = await redisClient.set(
    `winnow:scan-lock:${rootId}`,
    token,
    "PX",
    SCAN_LOCK_TTL_MS,
    "NX",
  );
  return ok ? token : null;
}

// Release the scan slot — but only if we still own it (compare-and-delete), so a
// holder whose TTL expired and was reacquired elsewhere doesn't drop another
// worker's lock.
export async function releaseScanLock(rootId: number, token: string): Promise<void> {
  try {
    await redisClient.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      `winnow:scan-lock:${rootId}`,
      token,
    );
  } catch (err) {
    console.warn(`releaseScanLock(${rootId}):`, (err as Error).message);
  }
}

export type IndexJob = { rootId: number };
export type DerivativeJob = { assetId: number };
export type ExportJob = { exportJobId: number };
export type PurgeJob = { purgeJobId: number };
// Reverse-geocode one asset (cf. lib/geocode.ts). `precise` (the manual "Resolve
// location" action) resolves at the exact coordinate and also fills the POI;
// omitted/false is the cheap shared-cell mode used by the backfill + import.
export type GeocodeJob = { assetId: number; precise?: boolean };
// ML-analyze one asset (cf. lib/ml.ts): faces + OCR read off its derivative.
export type MlJob = { assetId: number };
// Write a manually-set GPS position back into the ORIGINAL file's EXIF
// (cf. lib/exifWrite.ts, api/assets/geotag).
export type GpsWriteJob = { assetId: number };
// Integrity sweep (cf. lib/integrity.ts): re-stat every live original + verify
// the derivative objects still exist in storage. `rootId` scopes to one volume;
// omitted → the whole library.
export type IntegrityJob = { rootId?: number | null };
export type ImportJob = {
  sourceDir: string;
  origin: "web_upload" | "card_offload" | "inbox" | "ftp";
  removeAfter: boolean;
  batchId?: number;
};
export const QUEUES = {
  index: "winnow-index",
  derivatives: "winnow-derivatives",
  export: "winnow-export",
  import: "winnow-import",
  purge: "winnow-purge",
  geocode: "winnow-geocode",
  ml: "winnow-ml",
  integrity: "winnow-integrity",
  gpswrite: "winnow-gpswrite",
} as const;

declare global {
  // eslint-disable-next-line no-var
  var __winnowQueues:
    | {
        index: Queue;
        derivatives: Queue;
        export: Queue;
        import: Queue;
        purge: Queue;
        geocode: Queue;
        ml: Queue;
        integrity: Queue;
        gpswrite: Queue;
      }
    | undefined;
}

function build() {
  return {
    index: new Queue(QUEUES.index, { connection }),
    derivatives: new Queue(QUEUES.derivatives, { connection }),
    export: new Queue(QUEUES.export, { connection }),
    import: new Queue(QUEUES.import, { connection }),
    purge: new Queue(QUEUES.purge, { connection }),
    geocode: new Queue(QUEUES.geocode, { connection }),
    ml: new Queue(QUEUES.ml, { connection }),
    integrity: new Queue(QUEUES.integrity, { connection }),
    gpswrite: new Queue(QUEUES.gpswrite, { connection }),
  };
}

// Lazy instantiation: building a BullMQ `Queue` immediately opens a
// Redis connection (loading the Lua scripts). We don't want merely
// importing this module — at Next build time, for example — to try to reach Redis.
// The queues are created only on the first enqueue.
function getQueues() {
  if (!global.__winnowQueues) global.__winnowQueues = build();
  return global.__winnowQueues;
}

const defaultJobOpts = {
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
};

// "Pending" = queued but not yet running. We coalesce scans against these
// states only; an *active* scan is deliberately excluded so a request that
// arrives mid-scan still queues exactly one follow-up pass (the running walk may
// already have passed a directory where new files just landed).
const PENDING_INDEX_STATES = ["waiting", "prioritized", "delayed"] as const;

// The pending scan already queued for this root, if any. Cap the scan: with
// coalescing in place the pending set stays tiny, and this bounds the lookup if
// a legacy backlog hasn't drained yet.
async function findPendingIndexJob(rootId: number): Promise<Job | null> {
  const jobs = await getQueues().index.getJobs([...PENDING_INDEX_STATES], 0, 999);
  for (const job of jobs) {
    if (job && Number((job.data as IndexJob)?.rootId) === rootId) return job;
  }
  return null;
}

// Enqueue an incremental scan of a root, coalescing on the root id. Indexing is
// incremental + idempotent, so N queued passes of the same folder are pure
// wasted I/O on the NAS — we keep at most one pending scan per root. A more
// urgent request (e.g. an import) promotes the queued job's priority instead of
// stacking a duplicate. Returns the pending job (existing or freshly added).
export async function enqueueIndex(
  rootId: number,
  opts: { priority?: number } = {},
): Promise<Job> {
  const priority = opts.priority ?? PRIORITY.normal;
  const queue = getQueues().index;

  const pending = await findPendingIndexJob(rootId);
  if (pending) {
    const current =
      typeof pending.opts.priority === "number"
        ? pending.opts.priority
        : PRIORITY.normal;
    // Smaller number = higher priority. Best-effort promotion: the job may start
    // between the lookup and here, in which case changePriority throws and we
    // ignore it (the now-active scan already covers this request).
    if (priority < current) {
      try {
        await pending.changePriority({ priority });
      } catch {
        /* job already started */
      }
    }
    return pending;
  }

  return queue.add("scan", { rootId } satisfies IndexJob, {
    ...defaultJobOpts,
    priority,
  });
}

// One-shot reconciliation (run at worker startup): collapse any pre-existing
// duplicate scans so each root keeps a single pending job. Keeps the most urgent
// (highest priority, oldest on ties) and drops the rest. Self-healing — once
// enqueueIndex coalesces every caller, this finds nothing left to do. Returns
// the number of duplicate jobs removed.
export async function coalescePendingIndexJobs(): Promise<number> {
  const jobs = await getQueues().index.getJobs([...PENDING_INDEX_STATES], 0, 4999);
  const byRoot = new Map<number, Job[]>();
  for (const job of jobs) {
    if (!job) continue;
    const rootId = Number((job.data as IndexJob)?.rootId);
    if (!Number.isFinite(rootId)) continue;
    let group = byRoot.get(rootId);
    if (!group) {
      group = [];
      byRoot.set(rootId, group);
    }
    group.push(job);
  }

  let removed = 0;
  for (const group of byRoot.values()) {
    if (group.length <= 1) continue;
    const prio = (j: Job) =>
      typeof j.opts.priority === "number" ? j.opts.priority : PRIORITY.normal;
    // Highest priority first (smaller wins), then oldest first.
    group.sort((a, b) => prio(a) - prio(b) || (a.timestamp ?? 0) - (b.timestamp ?? 0));
    for (const dup of group.slice(1)) {
      try {
        await dup.remove();
        removed++;
      } catch {
        /* became active between listing and removal: leave it */
      }
    }
  }
  return removed;
}

export async function enqueueDerivative(
  assetId: number,
  opts: { priority?: number } = {},
) {
  return getQueues().derivatives.add(
    "derive",
    { assetId } satisfies DerivativeJob,
    { ...defaultJobOpts, priority: opts.priority ?? PRIORITY.normal },
  );
}

// --- Scan/analyze pipeline control ------------------------------------------

// Global pause/resume (persisted in Redis: workers of all processes
// respect it). We suspend indexing AND derivative generation.
export async function setScanPaused(paused: boolean): Promise<void> {
  const { index, derivatives } = getQueues();
  if (paused) await Promise.all([index.pause(), derivatives.pause()]);
  else await Promise.all([index.resume(), derivatives.resume()]);
}

// Priority of the next pending scan (smaller = higher priority), or null
// if no scan is waiting. Used to preempt a long scan with the incoming.
export async function nextWaitingIndexPriority(): Promise<number | null> {
  const jobs = await getQueues().index.getPrioritized(0, 0);
  const p = jobs[0]?.priority;
  return typeof p === "number" ? p : null;
}

export type QueueCounts = Record<string, number>;
export async function getQueueStats(): Promise<{
  scan: QueueCounts;
  analyze: QueueCounts;
  import: QueueCounts;
  paused: boolean;
}> {
  const { index, derivatives, import: imp } = getQueues();
  const states = ["waiting", "active", "prioritized", "delayed", "failed"] as const;
  const [scan, analyze, importCounts, paused] = await Promise.all([
    index.getJobCounts(...states),
    derivatives.getJobCounts(...states),
    imp.getJobCounts("waiting", "active", "delayed", "failed"),
    index.isPaused(),
  ]);
  return { scan, analyze, import: importCounts, paused };
}

// --- Queue introspection / triage (Pipeline pages) --------------------------

// Public queue names used by the Pipeline triage pages. We deliberately expose
// only scan/analyze (the two queues a human curates); import/export are managed
// elsewhere.
export type PublicQueueName = "scan" | "analyze";

function queueByName(name: PublicQueueName): Queue {
  const { index, derivatives } = getQueues();
  return name === "scan" ? index : derivatives;
}

// A flattened, UI-friendly view of a BullMQ job. `data` carries the job-specific
// payload (rootId for scan, assetId for analyze) the API enriches with DB rows.
export type QueueJobInfo = {
  id: string;
  name: string;
  state: string;
  data: Record<string, unknown>;
  priority: number | null;
  attemptsMade: number;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
};

// Includes "completed" so the triage pages can show a job's full run history
// (not just what's still pending or failed) — retained per queue up to
// `defaultJobOpts.removeOnComplete`/`removeOnFail`.
const LISTABLE_STATES = [
  "active",
  "waiting",
  "prioritized",
  "delayed",
  "completed",
  "failed",
] as const;

// Lists the pending/active/failed jobs of a queue (newest BullMQ ids first),
// capped so a huge backlog can't blow up the response.
export async function listQueueJobs(
  name: PublicQueueName,
  limit = 200,
): Promise<QueueJobInfo[]> {
  const queue = queueByName(name);
  const jobs = await queue.getJobs([...LISTABLE_STATES], 0, limit - 1);
  const out = await Promise.all(
    jobs.map(async (job): Promise<QueueJobInfo | null> => {
      if (!job?.id) return null;
      const state = await job.getState();
      return {
        id: String(job.id),
        name: job.name,
        state,
        data: (job.data ?? {}) as Record<string, unknown>,
        priority: typeof job.opts?.priority === "number" ? job.opts.priority : null,
        attemptsMade: job.attemptsMade ?? 0,
        timestamp: job.timestamp ?? null,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
        failedReason: job.failedReason ?? null,
      } satisfies QueueJobInfo;
    }),
  );
  return out.filter((j): j is QueueJobInfo => j !== null);
}

// Removes a single job from the queue. Active (locked) jobs can't be removed
// mid-flight: BullMQ throws, which we surface as `{ removed: false }`.
export async function removeQueueJob(
  name: PublicQueueName,
  jobId: string,
): Promise<{ removed: boolean; reason?: string }> {
  const queue = queueByName(name);
  const job = await queue.getJob(jobId);
  if (!job) return { removed: false, reason: "not found" };
  try {
    await job.remove();
    return { removed: true };
  } catch (err) {
    return { removed: false, reason: (err as Error).message };
  }
}

export async function enqueueExport(exportJobId: number) {
  return getQueues().export.add(
    "export",
    { exportJobId } satisfies ExportJob,
    defaultJobOpts,
  );
}

export async function enqueueImport(job: ImportJob) {
  return getQueues().import.add("import", job, defaultJobOpts);
}

export async function enqueuePurge(purgeJobId: number) {
  return getQueues().purge.add(
    "purge",
    { purgeJobId } satisfies PurgeJob,
    defaultJobOpts,
  );
}

// ML-analyze one asset (faces + OCR, cf. lib/ml.ts). Idempotent: the job
// replaces the asset's previous results wholesale, so re-enqueuing is harmless.
export async function enqueueMl(
  assetId: number,
  opts: { priority?: number } = {},
) {
  return getQueues().ml.add("ml", { assetId } satisfies MlJob, {
    ...defaultJobOpts,
    priority: opts.priority ?? PRIORITY.normal,
  });
}

// Enqueue an integrity sweep (cf. lib/integrity.ts), coalescing like scans do:
// the sweep walks the whole scope anyway, so stacking a second pending job is
// pure wasted NAS I/O — an already-queued sweep of the same scope is returned
// as-is (a global pending sweep also covers any per-root request).
export async function enqueueIntegrity(
  opts: { rootId?: number | null } = {},
): Promise<Job> {
  const queue = getQueues().integrity;
  const rootId = opts.rootId ?? null;
  const jobs = await queue.getJobs([...PENDING_INDEX_STATES], 0, 99);
  for (const job of jobs) {
    const queued = (job?.data as IntegrityJob)?.rootId ?? null;
    if (job && (queued === null || queued === rootId)) return job;
  }
  return queue.add("integrity", { rootId } satisfies IntegrityJob, {
    ...defaultJobOpts,
    // A sweep interrupted by pause returns cleanly (partial report); no retries.
    attempts: 1,
  });
}

// Write a manual GPS position back into the original file (cf. lib/exifWrite.ts).
// Idempotent: the job re-reads the asset's current coordinates at run time, so
// re-enqueuing (or geotagging twice before the worker catches up) just writes
// the latest value.
export async function enqueueGpsWrite(assetId: number) {
  return getQueues().gpswrite.add(
    "gpswrite",
    { assetId } satisfies GpsWriteJob,
    defaultJobOpts,
  );
}

// Reverse-geocode one asset. Cheap and idempotent (a cached cell makes no
// network call), so re-enqueuing a still-pending asset is harmless.
export async function enqueueGeocode(
  assetId: number,
  opts: { priority?: number; precise?: boolean } = {},
) {
  return getQueues().geocode.add(
    "geocode",
    { assetId, precise: opts.precise } satisfies GeocodeJob,
    { ...defaultJobOpts, priority: opts.priority ?? PRIORITY.normal },
  );
}
