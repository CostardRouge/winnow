// The opaque document bucket a client app keeps here (migration 0041).
//
// Winnow stores JSON it never reads, scoped to the signed-in user, guarded by
// an etag. Atelier is the first client: a Road Trip kept here resumes from
// another device. Everything that decides an answer lives in this module so
// the two route files stay thin wrappers, like every other lib/ + api/ pair.
//
// The three rules, in the order they matter:
//   1. Every query carries `user_id = $me`. A row that is not the caller's
//      does not exist as far as the answer goes: 404, never 403.
//   2. A write needs the revision the client holds (If-Match). Stale or
//      missing on an existing row → 412 carrying the current revision. A
//      client that holds an etag for a row that is gone → 404 (deleted
//      elsewhere). No If-Match on a row that does not exist → create.
//   3. The body is bounded (MAX_DOC_BYTES) and must be JSON. The route
//      requires `Content-Type: application/json`, which forces a CORS
//      preflight only an allowlisted origin passes (lib/cors.ts).
import { randomUUID } from "node:crypto";
import { many, one } from "./db";

export const DOC_KINDS = ["trip", "project"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

// Tens of KB is a big trip; 1 MiB is a generous ceiling that still keeps a
// runaway client from filling the table. Advertised in /api/capabilities.
export const MAX_DOC_BYTES = 1024 * 1024;

// The namespace a client writes under. Lowercase slug, so it can never be a
// path trick, and short, so it stays an index key rather than a payload.
const APP_RE = /^[a-z][a-z0-9-]{0,31}$/;
// A client-minted id — a UUID in practice, but anything a URL segment holds.
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidApp(app: string): boolean {
  return APP_RE.test(app);
}

export function isValidDocId(id: string): boolean {
  return ID_RE.test(id);
}

export function isDocKind(kind: unknown): kind is DocKind {
  return typeof kind === "string" && (DOC_KINDS as readonly string[]).includes(kind);
}

export type AppDocumentRow = {
  id: string;
  kind: DocKind;
  version: number;
  updated_at: string;
  etag: string;
  doc: unknown;
};

const ROW_SELECT = "id, kind, version, updated_at, etag, doc";

// Strong-validator ETag as HTTP writes it: quoted. Compared after stripping
// the quotes and a `W/` prefix, so a client echoing the header verbatim and
// one sending the bare revision both match.
export function quoteEtag(etag: string): string {
  return `"${etag}"`;
}

export function normalizeEtag(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^W\//i, "");
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1");
  return unquoted || null;
}

function newEtag(): string {
  return randomUUID().replace(/-/g, "");
}

export async function listDocuments(
  userId: number,
  app: string,
  kind: DocKind | null,
): Promise<AppDocumentRow[]> {
  return many<AppDocumentRow>(
    `SELECT ${ROW_SELECT} FROM app_documents
     WHERE user_id = $1 AND app = $2 AND ($3::text IS NULL OR kind = $3)
     ORDER BY updated_at DESC`,
    [userId, app, kind],
  );
}

export async function getDocument(
  userId: number,
  app: string,
  id: string,
): Promise<AppDocumentRow | null> {
  return one<AppDocumentRow>(
    `SELECT ${ROW_SELECT} FROM app_documents
     WHERE user_id = $1 AND app = $2 AND id = $3`,
    [userId, app, id],
  );
}

export type PutOutcome =
  | { status: "ok"; etag: string; updated_at: string; created: boolean }
  // Exists, and the revision the client holds is not the current one (or it
  // holds none). Carries the current revision so the client can decide.
  | { status: "conflict"; etag: string; updated_at: string }
  // Not the caller's row, or the client holds a revision for a row that is
  // gone. Both are "not found" to the caller — the first must not say more.
  | { status: "notfound" };

export async function putDocument(
  userId: number,
  app: string,
  id: string,
  body: { kind: DocKind; version: number; doc: unknown },
  ifMatch: string | null,
): Promise<PutOutcome> {
  // The primary key is (app, id) across every user, so another user's row
  // with this id blocks a create — answered as 404, not 412, so nothing
  // about that row (not even its revision) leaks.
  const current = await one<{ user_id: number; etag: string; updated_at: string }>(
    `SELECT user_id, etag, updated_at FROM app_documents WHERE app = $1 AND id = $2`,
    [app, id],
  );
  if (current && current.user_id !== userId) return { status: "notfound" };

  const etag = newEtag();
  const docJson = JSON.stringify(body.doc);

  if (!current) {
    if (ifMatch) return { status: "notfound" };
    const row = await one<{ updated_at: string }>(
      `INSERT INTO app_documents (app, id, user_id, kind, version, doc, etag)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING updated_at`,
      [app, id, userId, body.kind, body.version, docJson, etag],
    );
    return { status: "ok", etag, updated_at: row!.updated_at, created: true };
  }

  if (!ifMatch || ifMatch !== current.etag) {
    return { status: "conflict", etag: current.etag, updated_at: current.updated_at };
  }

  // The etag in the WHERE is what makes the check atomic: two writers racing
  // past the SELECT above cannot both succeed here.
  const row = await one<{ updated_at: string }>(
    `UPDATE app_documents
     SET kind = $4, version = $5, doc = $6::jsonb, etag = $7, updated_at = now()
     WHERE app = $1 AND id = $2 AND user_id = $3 AND etag = $8
     RETURNING updated_at`,
    [app, id, userId, body.kind, body.version, docJson, etag, ifMatch],
  );
  if (!row) {
    const latest = await one<{ etag: string; updated_at: string }>(
      `SELECT etag, updated_at FROM app_documents WHERE app = $1 AND id = $2 AND user_id = $3`,
      [app, id, userId],
    );
    return latest
      ? { status: "conflict", etag: latest.etag, updated_at: latest.updated_at }
      : { status: "notfound" };
  }
  return { status: "ok", etag, updated_at: row.updated_at, created: false };
}

export type DeleteOutcome =
  | { status: "ok" }
  | { status: "conflict"; etag: string; updated_at: string }
  | { status: "notfound" };

export async function deleteDocument(
  userId: number,
  app: string,
  id: string,
  ifMatch: string | null,
): Promise<DeleteOutcome> {
  const current = await one<{ etag: string; updated_at: string }>(
    `SELECT etag, updated_at FROM app_documents WHERE app = $1 AND id = $2 AND user_id = $3`,
    [app, id, userId],
  );
  if (!current) return { status: "notfound" };
  if (!ifMatch || ifMatch !== current.etag) {
    return { status: "conflict", etag: current.etag, updated_at: current.updated_at };
  }
  const r = await many<{ id: string }>(
    `DELETE FROM app_documents WHERE app = $1 AND id = $2 AND user_id = $3 AND etag = $4
     RETURNING id`,
    [app, id, userId, ifMatch],
  );
  return r.length ? { status: "ok" } : { status: "notfound" };
}
