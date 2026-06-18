// Point d'entrée des workers BullMQ (cf. §3).
// Concurrence bornée pour ménager le HDD plein du NAS et l'Optiplex.
import { Worker } from "bullmq";
import { config } from "./lib/config";
import {
  connection,
  QUEUES,
  enqueueImport,
  type IndexJob,
  type DerivativeJob,
  type ExportJob,
  type ImportJob,
} from "./lib/queue";
import { indexRoot } from "./lib/indexer";
import { generateDerivative } from "./lib/derivatives";
import { runExportJob } from "./lib/export";
import { runImport } from "./lib/import";
import { startInboxWatcher } from "./lib/watcher";
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

const importWorker = new Worker(
  QUEUES.import,
  async (job) => {
    const data = job.data as ImportJob;
    console.log(`[import] ${data.origin} ← ${data.sourceDir}`);
    const res = await runImport(data);
    console.log(`[import] terminé`, res);
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
    console.error(`[${name}] échec job ${job?.id}:`, err.message),
  );
}

// Surveillance de l'inbox : dépôts SMB / FTP / upload → import automatique.
const stopWatcher = config.import.watchInbox
  ? startInboxWatcher(config.import.inboxDir, (sourceDir) =>
      enqueueImport({ sourceDir, origin: "inbox", removeAfter: true }),
    )
  : null;

async function shutdown() {
  console.log("Arrêt des workers…");
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
