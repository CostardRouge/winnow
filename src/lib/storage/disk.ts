// Backend disque (MVP). Les clés sont mappées sur des chemins de fichiers sous
// STORAGE_DISK_PATH. Pas d'URL signée : la route API sert les octets.
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { Storage } from "./index";

function safeJoin(base: string, key: string): string {
  // Empêche toute remontée hors du répertoire de base via la clé.
  const target = path.resolve(base, key);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Clé de stockage invalide : ${key}`);
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
    return null; // servi par /api/assets/:id/(thumb|proxy)
  }
}
