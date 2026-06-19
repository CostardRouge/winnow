// Inbox watching. SMB/FTP drops and uploads land in the inbox; we wait for each
// file to be *fully written* (awaitWriteFinish - crucial for RAWs/videos
// transferred over the network), then we queue a single import for the whole
// folder (debounce).
import chokidar, { type FSWatcher } from "chokidar";
import { mkdirSync } from "node:fs";

export function startInboxWatcher(
  inboxDir: string,
  onBatch: (sourceDir: string) => Promise<unknown>,
): () => Promise<void> {
  try {
    mkdirSync(inboxDir, { recursive: true });
  } catch {
    /* already present */
  }

  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onBatch(inboxDir).catch((err) =>
        console.error("[watcher] import failed:", (err as Error).message),
      );
    }, 3000);
  };

  const watcher: FSWatcher = chokidar.watch(inboxDir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
    ignored: /(^|[/\\])\../, // hidden files/dirs
  });

  watcher.on("add", schedule);
  console.log(`[watcher] inbox watched: ${inboxDir}`);

  return async () => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}
