// Abstraction de stockage des dérivés.
//
// Décision §12.1 : cache disque pour le MVP, MAIS derrière une interface de type
// S3 pour pouvoir brancher MinIO plus tard sans toucher au reste du code.
// Le code manipule toujours des "clés" (thumb_key / proxy_key) ; il ne connaît
// jamais le système de fichiers sous-jacent.

import { config } from "../config";

export interface Storage {
  /** Écrit des octets sous une clé. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Lit les octets d'une clé (null si absente). */
  get(key: string): Promise<Buffer | null>;
  /** Supprime une clé (sans erreur si absente). */
  del(key: string): Promise<void>;
  /**
   * URL d'accès direct, signée si le backend le permet (MinIO/S3).
   * Pour le disque, renvoie null : l'app sert les octets via une route API.
   */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string | null>;
}

let _storage: Storage | null = null;

export async function getStorage(): Promise<Storage> {
  if (_storage) return _storage;
  if (config.storage.driver === "s3") {
    const { S3Storage } = await import("./s3");
    _storage = new S3Storage();
  } else {
    const { DiskStorage } = await import("./disk");
    _storage = new DiskStorage();
  }
  return _storage;
}
