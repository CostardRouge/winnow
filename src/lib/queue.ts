// Files Redis (BullMQ). Trois files découplées (cf. §3) :
//  - index       : scan incrémental d'un root
//  - derivatives : génération thumbnail + proxie
//  - export      : jobs d'export (copie RAW pour C1, etc.)
import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

// BullMQ embarque sa propre copie d'ioredis ; on partage une instance et on
// neutralise le conflit de types nominaux par un cast à la frontière.
const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  // Pas de connexion tant qu'aucune commande n'est émise (évite les tentatives
  // au build/import quand Redis n'est pas joignable).
  lazyConnect: true,
});
export const connection = redis as unknown as ConnectionOptions;

// Sonde de vivacité Redis pour le healthcheck (échec rapide via timeout).
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

// Instanciation paresseuse : construire un `Queue` BullMQ ouvre aussitôt une
// connexion Redis (chargement des scripts Lua). On ne veut pas que le simple
// import de ce module — au build Next, par exemple — tente de joindre Redis.
// Les files ne sont créées qu'au premier enqueue.
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

export async function enqueueIndex(rootId: number) {
  return getQueues().index.add(
    "scan",
    { rootId } satisfies IndexJob,
    defaultJobOpts,
  );
}

export async function enqueueDerivative(assetId: number) {
  return getQueues().derivatives.add(
    "derive",
    { assetId } satisfies DerivativeJob,
    defaultJobOpts,
  );
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
