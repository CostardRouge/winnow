// Partial hash for deduplication (decision §12.3) and change detection.
// We do NOT read the whole file (RAW = tens of MB): we combine the size
// and two windows (start + end). Sufficient to dedup originals; a partial-hash
// collision is improbable but POSSIBLE (same size + endpoints, different middle).
// To avoid silently dropping a distinct file, callers confirm a suspected
// duplicate with sameContent() before discarding it (see review §4).
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";

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

// Full (whole-file) SHA-256. Streamed, so a large RAW never sits in memory.
// Reserved for the rare collision path — never used in the hot indexing loop.
async function fullHash(absPath: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return h.digest("hex");
}

// Confirms whether two paths hold byte-identical content. Called ONLY when a
// partial-hash collision is detected, to tell a genuine duplicate from a false
// collision before discarding a file.
//   true  -> identical content (safe to treat as a duplicate)
//   false -> distinct content (FALSE collision — the file must NOT be dropped)
//   null  -> a side could not be read; caller keeps the conservative behavior
//            (treat as duplicate) but should log it as unverified.
export async function sameContent(
  a: string,
  b: string,
): Promise<boolean | null> {
  try {
    const [ha, hb] = await Promise.all([fullHash(a), fullHash(b)]);
    return ha === hb;
  } catch {
    return null;
  }
}
