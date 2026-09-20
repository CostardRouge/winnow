// The binary half of a client app's own storage (migration 0044), cf.
// api/apps/[app]/files/*.
//
// The document bucket (appDocuments.ts) holds JSON Winnow never reads, up to
// 1 MiB. This holds BYTES it never reads either, up to MAX_FILE_BYTES — what a
// client keeps that is too big or too binary for a document: Atelier's
// purchased LUT lattices (1.5–2 MB apiece, 40 MB a pack) whose small index
// stays a document.
//
// The three rules, in the order they matter:
//   1. Every query carries `user_id = $me`. A row that is not the caller's
//      does not exist as far as the answer goes: 404, never 403.
//   2. The id IS the content hash. The route hashes what it received and
//      refuses a mismatch, so a blob can never be served under a name that
//      does not describe it — which is also what makes the answer immutable
//      and cacheable forever, and what lets a client ask "do you hold this?"
//      before sending anything.
//   3. Two caps, both stated in /api/capabilities: one file, and one user's
//      total for this app. A client checks them before sending; the route
//      enforces them because a client may be wrong or hostile.
import { createHash } from "node:crypto";
import { many, one } from "./db";
import { getStorage } from "./storage";

// A lattice is 1.57 MB at 65³; 16 MiB leaves room for whatever a client keeps
// next without letting one request become an upload service. Advertised.
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
// A whole LUT pack is ~40 MB and a person keeps a handful; 512 MiB is generous
// and still bounded. Enforced per (user, app) — one app cannot eat another's.
export const MAX_USER_BYTES = 512 * 1024 * 1024;

// Lowercase hex SHA-256, exactly 64 characters: the only id shape this bucket
// takes, so the id can never be a path trick.
const HASH_RE = /^[0-9a-f]{64}$/;

// Served back verbatim, so it is bounded to something harmless: no HTML, no
// SVG, nothing a browser would run if a link to it were followed.
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const FORBIDDEN_MEDIA = /^(text\/html|image\/svg\+xml|application\/xhtml)/;

export function isValidFileId(id: string): boolean {
  return HASH_RE.test(id);
}

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** The declared type, or the safe default — never something a browser runs. */
export function safeMediaType(raw: string | null): string {
  const value = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (!value || !MEDIA_TYPE_RE.test(value)) return DEFAULT_MEDIA_TYPE;
  if (FORBIDDEN_MEDIA.test(value)) return DEFAULT_MEDIA_TYPE;
  return value;
}

export type AppFileRow = {
  id: string;
  bytes: string | number;
  media_type: string;
  storage_key: string;
  created_at: string;
};

const ROW_SELECT = "id, bytes, media_type, storage_key, created_at";

/** Where the bytes live. Per user, so one account's blobs are never another's. */
function storageKey(userId: number, app: string, id: string): string {
  return `app-files/${userId}/${app}/${id}`;
}

export async function listFiles(userId: number, app: string): Promise<AppFileRow[]> {
  return many<AppFileRow>(
    `SELECT ${ROW_SELECT} FROM app_files
     WHERE user_id = $1 AND app = $2
     ORDER BY created_at DESC`,
    [userId, app],
  );
}

/** What this user already stores for this app, in bytes — the quota ledger. */
export async function usedBytes(userId: number, app: string): Promise<number> {
  const row = await one<{ total: string | null }>(
    `SELECT COALESCE(SUM(bytes), 0)::bigint AS total FROM app_files
     WHERE user_id = $1 AND app = $2`,
    [userId, app],
  );
  return Number(row?.total ?? 0);
}

export async function getFileRow(
  userId: number,
  app: string,
  id: string,
): Promise<AppFileRow | null> {
  return one<AppFileRow>(
    `SELECT ${ROW_SELECT} FROM app_files
     WHERE user_id = $1 AND app = $2 AND id = $3`,
    [userId, app, id],
  );
}

/** The bytes themselves, or null when the row or its blob is gone. */
export async function readFileBytes(row: AppFileRow): Promise<Buffer | null> {
  const storage = await getStorage();
  return storage.get(row.storage_key);
}

export type PutFileOutcome =
  | { status: "ok"; bytes: number; created: boolean }
  // The bytes do not hash to the id in the URL.
  | { status: "mismatch"; actual: string }
  | { status: "too-large"; limit: number }
  // Would push this user's total for this app past MAX_USER_BYTES.
  | { status: "quota"; used: number; limit: number };

/**
 * Store a blob under its own hash.
 *
 * Idempotent by construction: the same bytes under the same id answer "ok,
 * not created" without writing again, which is what makes a sync's "push
 * everything I have" cheap and a retry harmless.
 */
export async function putFile(
  userId: number,
  app: string,
  id: string,
  body: Buffer,
  mediaType: string,
): Promise<PutFileOutcome> {
  if (body.byteLength > MAX_FILE_BYTES) {
    return { status: "too-large", limit: MAX_FILE_BYTES };
  }
  const actual = sha256Hex(body);
  if (actual !== id) return { status: "mismatch", actual };

  const existing = await getFileRow(userId, app, id);
  if (existing) {
    // Content-addressed: the same id IS the same bytes. Nothing to rewrite.
    return { status: "ok", bytes: Number(existing.bytes), created: false };
  }

  const used = await usedBytes(userId, app);
  if (used + body.byteLength > MAX_USER_BYTES) {
    return { status: "quota", used, limit: MAX_USER_BYTES };
  }

  const key = storageKey(userId, app, id);
  const storage = await getStorage();
  // Bytes first, row second: a crash between the two leaves an orphan blob (a
  // janitor can find it by listing the prefix against this table), while the
  // other order would leave a row promising bytes that are not there.
  await storage.put(key, body, mediaType);
  await one(
    `INSERT INTO app_files (app, id, user_id, bytes, media_type, storage_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app, id, user_id) DO NOTHING
     RETURNING id`,
    [app, id, userId, body.byteLength, mediaType, key],
  );
  return { status: "ok", bytes: body.byteLength, created: true };
}

/** Forget a blob. Absent is not an error to the caller who asked for it gone. */
export async function deleteFile(userId: number, app: string, id: string): Promise<boolean> {
  const row = await getFileRow(userId, app, id);
  if (!row) return false;
  const storage = await getStorage();
  await storage.del(row.storage_key);
  await many(
    `DELETE FROM app_files WHERE app = $1 AND id = $2 AND user_id = $3 RETURNING id`,
    [app, id, userId],
  );
  return true;
}
