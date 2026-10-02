// BE-02 (docs/CODEBASE-AUDIT.md): the dedup actions removed files on the
// strength of a duplicate_hits row that may be stale — a row is recorded
// "unverifiable" precisely when the other side could not be read. The rule
// these pin: never remove a copy unless another copy of the same content is on
// disk now. Database-backed: runs only with WINNOW_TEST_DATABASE_URL.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

const base = await mkdtemp(path.join(os.tmpdir(), "winnow-dedup-test-"));
const library = path.join(base, "library");
const incoming = path.join(base, "incoming");
// Both zones sit inside the browse roots (INCOMING_DIR is one), and neither is
// view-only (no finals/export root covers them).
useTestDatabase({ INCOMING_DIR: base, BROWSE_ROOTS: base });

let dups: typeof import("./duplicates");
let db: typeof import("./db");
let sessionId: number;

before(async () => {
  if (skipWithoutDb) return;
  dups = await import("./duplicates");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [library],
  );
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'test', $2) RETURNING id",
    [root!.id, library],
  );
  sessionId = s!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await rm(library, { recursive: true, force: true });
  await rm(incoming, { recursive: true, force: true });
  await mkdir(library, { recursive: true });
  await mkdir(incoming, { recursive: true });
});

after(async () => {
  if (!skipWithoutDb) {
    await db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
    await db.q("DELETE FROM roots WHERE path = $1", [library]);
    await db.pool.end();
  }
  await rm(base, { recursive: true, force: true });
});

const exists = (p: string) => stat(p).then(() => true, () => false);
const HASH = () => `test-${randomBytes(8).toString("hex")}`;

// A library asset holding `hash` at `absPath`; the file is written only when
// `bytes` is given (no bytes = the original moved or was removed by hand).
async function asset(absPath: string, hash: string, bytes?: Buffer): Promise<number> {
  if (bytes) await writeFile(absPath, bytes);
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, file_size, content_hash)
     VALUES ($1, $2, $3, $4, 'jpg', 'photo', $5, $6) RETURNING id`,
    [sessionId, absPath, path.basename(absPath), path.basename(absPath), bytes?.length ?? 0, hash],
  );
  return row!.id;
}

// A recorded on-disk copy (duplicate_hits row) and its file.
async function hit(absPath: string, hash: string, bytes: Buffer, verified: boolean | null, assetId: number | null) {
  await writeFile(absPath, bytes);
  await db.q(
    `INSERT INTO duplicate_hits (abs_path, content_hash, existing_asset_id, source, verified, file_size)
     VALUES ($1, $2, $3, 'index', $4, $5)`,
    [absPath, hash, assetId, verified, bytes.length],
  );
}

const lib = (n: string) => path.join(library, n);
const inc = (n: string) => path.join(incoming, n);

test("keep: a copy that has vanished since it was recorded is refused, nothing deleted", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(100_000);
  const h = HASH();
  const id = await asset(lib("A.jpg"), h, bytes);
  await hit(inc("A.jpg"), h, bytes, true, id);
  await rm(inc("A.jpg")); // the recorded copy is gone, the row is stale

  await assert.rejects(
    dups.keepOneCopy({ contentHash: h, keepPath: inc("A.jpg") }),
    (e: Error) => e instanceof dups.DuplicateError && /no longer on disk/.test(e.message),
  );
  assert.equal(await exists(lib("A.jpg")), true, "the library file survives");
  const row = await db.one<{ abs_path: string }>("SELECT abs_path FROM assets WHERE id = $1", [id]);
  assert.equal(row!.abs_path, lib("A.jpg"), "and its row was not relinked");
});

test("keep: an unverified copy whose bytes differ is skipped, not deleted", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(100_000);
  const other = randomBytes(100_000); // same size, different content
  const h = HASH();
  const id = await asset(lib("B.jpg"), h, bytes);
  await hit(inc("B.jpg"), h, other, null, id);

  const r = await dups.keepOneCopy({ contentHash: h, keepPath: lib("B.jpg") });

  assert.deepEqual(r.deleted, []);
  assert.equal(r.skipped.length, 1);
  assert.equal(await exists(inc("B.jpg")), true);
});

test("keep: verified extra copies are still deleted", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(100_000);
  const h = HASH();
  const id = await asset(lib("C.jpg"), h, bytes);
  await hit(inc("C.jpg"), h, bytes, true, id);

  const r = await dups.keepOneCopy({ contentHash: h, keepPath: lib("C.jpg") });

  assert.deepEqual(r.deleted, [inc("C.jpg")]);
  assert.equal(await exists(inc("C.jpg")), false);
  assert.equal(await exists(lib("C.jpg")), true);
});

test("keep: a moved original is still relinked onto its new location", { skip: skipWithoutDb }, async () => {
  // The documented repair: the row's path is gone, the file lives on elsewhere.
  const bytes = randomBytes(100_000);
  const h = HASH();
  const id = await asset(lib("D.jpg"), h); // no file at the old path
  await hit(inc("D.jpg"), h, bytes, null, id);

  const r = await dups.keepOneCopy({ contentHash: h, keepPath: inc("D.jpg") });

  assert.equal(r.relinked, true);
  assert.equal(await exists(inc("D.jpg")), true);
  const row = await db.one<{ abs_path: string }>("SELECT abs_path FROM assets WHERE id = $1", [id]);
  assert.equal(row!.abs_path, inc("D.jpg"));
});

test("delete: the only remaining copy is not deleted when the library original is gone", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(100_000);
  const h = HASH();
  const id = await asset(lib("E.jpg"), h); // the original moved away
  await hit(inc("E.jpg"), h, bytes, null, id);

  const r = await dups.deleteDuplicateFiles([inc("E.jpg")]);

  assert.deepEqual(r.deleted, []);
  assert.equal(await exists(inc("E.jpg")), true);
});

test("delete: two copies that are each other's only survivor are not both removed", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(100_000);
  const h = HASH();
  const id = await asset(lib("F.jpg"), h); // library original gone
  await hit(inc("F1.jpg"), h, bytes, true, id);
  await hit(inc("F2.jpg"), h, bytes, true, id);

  await dups.deleteDuplicateFiles([inc("F1.jpg"), inc("F2.jpg")]);

  const left = [await exists(inc("F1.jpg")), await exists(inc("F2.jpg"))].filter(Boolean);
  assert.equal(left.length, 1, "exactly one copy must remain");
});

test("delete: a verified extra copy beside a present original is deleted", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(100_000);
  const h = HASH();
  const id = await asset(lib("G.jpg"), h, bytes);
  await hit(inc("G.jpg"), h, bytes, true, id);

  const r = await dups.deleteDuplicateFiles([inc("G.jpg")]);

  assert.deepEqual(r.deleted, [inc("G.jpg")]);
  assert.equal(await exists(lib("G.jpg")), true);
});
