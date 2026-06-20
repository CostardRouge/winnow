// Redis queues (BullMQ). Three decoupled queues (cf. §3):
//  - index       : incremental scan of a root
//  - derivatives : thumbnail + proxy generation
//  - export      : export jobs (RAW copy for C1, etc.)
import { Queue, type ConnectionOptions } from "bullmq";
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

export type IndexJob = { rootId: number };
export type DerivativeJob = { assetId: number };
export type ExportJob = { exportJobId: number };
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
} as const;

declare global {
  // eslint-disable-next-line no-var
  var __winnowQueues:
    | {
        index: Queue;
        derivatives: Queue;
        export: Queue;
        import: Queue;
      }
    | undefined;
}

function build() {
  return {
    index: new Queue(QUEUES.index, { connection }),
    derivatives: new Queue(QUEUES.derivatives, { connection }),
    export: new Queue(QUEUES.export, { connection }),
    import: new Queue(QUEUES.import, { connection }),
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

export async function enqueueIndex(
  rootId: number,
  opts: { priority?: number } = {},
) {
  return getQueues().index.add("scan", { rootId } satisfies IndexJob, {
    ...defaultJobOpts,
    priority: opts.priority ?? PRIORITY.normal,
  });
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
  failedReason: string | null;
};

const LISTABLE_STATES = [
  "active",
  "waiting",
  "prioritized",
  "delayed",
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
