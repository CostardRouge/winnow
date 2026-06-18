// Files Redis (BullMQ). Trois files découplées (cf. §3) :
//  - index       : scan incrémental d'un root
//  - derivatives : génération thumbnail + proxie
//  - export      : jobs d'export (copie RAW pour C1, etc.)
import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

// BullMQ embarque sa propre copie d'ioredis ; on partage une instance et on
// neutralise le conflit de types nominaux par un cast à la frontière.
export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  // Pas de connexion tant qu'aucune commande n'est émise (évite les tentatives
  // au build/import quand Redis n'est pas joignable).
  lazyConnect: true,
}) as unknown as ConnectionOptions;

export type IndexJob = { rootId: number };
export type DerivativeJob = { assetId: number };
export type ExportJob = { exportJobId: number };

export const QUEUES = {
  index: "winnow-index",
  derivatives: "winnow-derivatives",
  export: "winnow-export",
} as const;

declare global {
  // eslint-disable-next-line no-var
  var __winnowQueues:
    | { index: Queue; derivatives: Queue; export: Queue }
    | undefined;
}

function build() {
  return {
    index: new Queue(QUEUES.index, { connection }),
    derivatives: new Queue(QUEUES.derivatives, { connection }),
    export: new Queue(QUEUES.export, { connection }),
  };
}

export const queues = global.__winnowQueues ?? build();
if (process.env.NODE_ENV !== "production") {
  global.__winnowQueues = queues;
}

const defaultJobOpts = {
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
};

export async function enqueueIndex(rootId: number) {
  return queues.index.add("scan", { rootId } satisfies IndexJob, defaultJobOpts);
}

export async function enqueueDerivative(assetId: number) {
  return queues.derivatives.add(
    "derive",
    { assetId } satisfies DerivativeJob,
    defaultJobOpts,
  );
}

export async function enqueueExport(exportJobId: number) {
  return queues.export.add(
    "export",
    { exportJobId } satisfies ExportJob,
    defaultJobOpts,
  );
}
