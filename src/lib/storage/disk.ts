// Disk backend (MVP). Keys are mapped to file paths under
// STORAGE_DISK_PATH. No signed URL: the API route serves the bytes.
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
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

  async del(key: string): Promise<void> {
    await rm(safeJoin(this.base, key), { force: true });
  }

  async signedUrl(): Promise<string | null> {
    return null; // served by /api/assets/:id/(thumb|proxy)
  }
}
