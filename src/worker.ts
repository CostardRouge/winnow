// Point d'entrée des workers BullMQ (cf. §3).
// Concurrence bornée pour ménager le HDD plein du NAS et l'Optiplex.
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

console.log("Winnow workers — démarrage");
console.log(`  stockage : ${config.storage.driver}`);
console.log(`  concurrence dérivés : ${config.derivativeConcurrency}`);

const indexWorker = new Worker(
  QUEUES.index,
  async (job) => {
    const { rootId } = job.data as IndexJob;
    const myPriority = job.opts.priority ?? PRIORITY.normal;
    console.log(`[index] root ${rootId}…`);

    // Préemption : un scan ordinaire cède la place dès qu'un scan plus
    // prioritaire (incoming/inbox) attend. Le résultat est mis en cache 2 s
    // pour borner les appels Redis sur les gros arbres.
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
        // Goutte-à-goutte : on attend le prochain créneau, en re-vérifiant
        // périodiquement la pause/préemption pour rester réactif.
        let wait = await reserveSlot("scan", scanPerHour);
        while (wait > 0) {
          await sleep(Math.min(wait, 3000));
          if ((await getSettings()).scanPaused || (await higherWaiting())) return;
          wait = await reserveSlot("scan", scanPerHour);
        }
      },
    });
    console.log(`[index] terminé`, res);

    // Interruption par préemption (pas par pause) : on ré-enfile le root pour
    // reprendre l'indexation incrémentale une fois le prioritaire écoulé.
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
    // Lissage du débit d'analyse (dérivés). Au-delà du quota, on rate-limite
    // tout le worker jusqu'au prochain créneau et on remet le job en file
    // (sans le compter en échec) : les dérivés prioritaires repartiront en tête.
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

// Enregistre + (ré)indexe les roots connus (incoming + dossiers finaux
// configurés) dès le démarrage, sans bloquer la boucle des workers.
void bootstrapRoots();

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
