// Point d'entrée des workers BullMQ (cf. §3).
// Concurrence bornée pour ménager le HDD plein du NAS et l'Optiplex.
import { Worker } from "bullmq";
import { config } from "./lib/config";
import {
  connection,
  QUEUES,
  type IndexJob,
  type DerivativeJob,
  type ExportJob,
} from "./lib/queue";
import { indexRoot } from "./lib/indexer";
import { generateDerivative } from "./lib/derivatives";
import { runExportJob } from "./lib/export";
import { closeExiftool } from "./lib/extract";

console.log("Winnow workers — démarrage");
console.log(`  stockage : ${config.storage.driver}`);
console.log(`  concurrence dérivés : ${config.derivativeConcurrency}`);

const indexWorker = new Worker(
  QUEUES.index,
  async (job) => {
    const { rootId } = job.data as IndexJob;
    console.log(`[index] root ${rootId}…`);
    const res = await indexRoot(rootId);
    console.log(`[index] terminé`, res);
    return res;
  },
  { connection, concurrency: config.scanConcurrency },
);

const derivativeWorker = new Worker(
  QUEUES.derivatives,
  async (job) => {
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

for (const [name, w] of [
  ["index", indexWorker],
  ["derivatives", derivativeWorker],
  ["export", exportWorker],
] as const) {
  w.on("failed", (job, err) =>
    console.error(`[${name}] échec job ${job?.id}:`, err.message),
  );
}

async function shutdown() {
  console.log("Arrêt des workers…");
  await Promise.allSettled([
    indexWorker.close(),
    derivativeWorker.close(),
    exportWorker.close(),
  ]);
  await closeExiftool();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
