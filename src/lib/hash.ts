// Partial hash for deduplication (decision §12.3) and change detection.
// We do NOT read the whole file (RAW = tens of MB): we combine the size
// and two windows (start + end). Sufficient to dedup originals;
// collisions are improbable and tolerated in the MVP.
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const WINDOW = 64 * 1024; // 64 KiB

export async function partialHash(
  absPath: string,
  size: number,
): Promise<string> {
  const h = createHash("sha256");
  h.update(String(size));

  const fh = await open(absPath, "r");
  try {
    const head = Buffer.alloc(Math.min(WINDOW, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);

    if (size > WINDOW) {
      const tailLen = Math.min(WINDOW, size - WINDOW);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}
