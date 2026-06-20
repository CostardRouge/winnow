// Disk backend (MVP). Keys are mapped to file paths under
// STORAGE_DISK_PATH. No signed URL: the API route serves the bytes.
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, rm, stat as fsStat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { config } from "../config";
import type { Storage } from "./index";

function safeJoin(base: string, key: string): string {
  // Prevents any traversal outside the base directory via the key.
  const target = path.resolve(base, key);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return target;
}

export class DiskStorage implements Storage {
  private base = path.resolve(config.storage.diskPath);

  async put(key: string, body: Buffer): Promise<void> {
    const target = safeJoin(this.base, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(safeJoin(this.base, key));
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const s = await fsStat(safeJoin(this.base, key));
      return { size: s.size };
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async getRange(
    key: string,
    start: number,
    end: number,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const target = safeJoin(this.base, key);
    // Confirm the key exists up-front so a missing file is a clean null (404),
    // not a stream that errors out mid-response.
    try {
      await fsStat(target);
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    // `end` is inclusive for createReadStream, matching HTTP Range semantics.
    // Only the [start, end] window is read off disk — never the whole file.
    const node = createReadStream(target, { start, end });
    return Readable.toWeb(node) as ReadableStream<Uint8Array>;
  }

  async del(key: string): Promise<void> {
    await rm(safeJoin(this.base, key), { force: true });
  }

  async signedUrl(): Promise<string | null> {
    return null; // served by /api/assets/:id/(thumb|proxy)
  }
}
