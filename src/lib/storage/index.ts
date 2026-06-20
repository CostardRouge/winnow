// Derivatives storage abstraction.
//
// Decision §12.1: disk cache for the MVP, BUT behind an S3-like interface so we
// can plug in MinIO later without touching the rest of the code.
// The code always manipulates "keys" (thumb_key / proxy_key); it never knows
// the underlying file system.

import { config } from "../config";

export interface Storage {
  /** Writes bytes under a key. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Reads a key's bytes (null if absent). */
  get(key: string): Promise<Buffer | null>;
  /** Size (and existence) of a key without reading its bytes (null if absent). */
  stat(key: string): Promise<{ size: number } | null>;
  /**
   * Streams an inclusive byte range [start, end] of a key (null if absent).
   * Lets us serve video Range/seek requests without loading the whole file
   * into RAM on every request.
   */
  getRange(
    key: string,
    start: number,
    end: number,
  ): Promise<ReadableStream<Uint8Array> | null>;
  /** Deletes a key (no error if absent). */
  del(key: string): Promise<void>;
  /**
   * Direct-access URL, signed if the backend allows it (MinIO/S3).
   * For disk, returns null: the app serves the bytes via an API route.
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
