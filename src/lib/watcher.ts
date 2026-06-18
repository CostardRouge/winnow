// Surveillance de l'inbox. Les dépôts SMB/FTP et les uploads tombent dans
// l'inbox ; on attend que chaque fichier soit *complètement écrit*
// (awaitWriteFinish — crucial pour des RAW/vidéos transférés sur le réseau),
// puis on enfile un import unique pour tout le dossier (débounce).
import chokidar, { type FSWatcher } from "chokidar";
import { mkdirSync } from "node:fs";

export function startInboxWatcher(
  inboxDir: string,
  onBatch: (sourceDir: string) => Promise<unknown>,
): () => Promise<void> {
  try {
    mkdirSync(inboxDir, { recursive: true });
  } catch {
    /* déjà présent */
  }

  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onBatch(inboxDir).catch((err) =>
        console.error("[watcher] import échoué:", (err as Error).message),
      );
    }, 3000);
  };

  const watcher: FSWatcher = chokidar.watch(inboxDir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
    ignored: /(^|[/\\])\../, // fichiers/dirs cachés
  });

  watcher.on("add", schedule);
  console.log(`[watcher] inbox surveillée : ${inboxDir}`);

  return async () => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}
