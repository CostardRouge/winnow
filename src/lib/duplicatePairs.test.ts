// The folder-pair view of the deduplication backlog: two-copy groups are
// aggregated by their two folders, a pair's run keeps one side and touches
// nothing outside the pair, and a view-only side is never the one dropped.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL.
//
// Every query carries `q: base` — the listing reads the whole duplicate_hits
// table, and other test files write to it in parallel.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

const base = await mkdtemp(path.join(os.tmpdir(), "winnow-dedup-pairs-"));
const library = path.join(base, "library");
const backup = path.join(base, "incoming", "backup");
const other = path.join(base, "incoming", "other");
const finals = path.join(base, "finals");
const exportsDir = path.join(base, "incoming", "exports");
useTestDatabase({ INCOMING_DIR: base, BROWSE_ROOTS: base });

let pairs: typeof import("./duplicatePairs");
let db: typeof import("./db");
let sessionId: number;

before(async () => {
  if (skipWithoutDb) return;
  pairs = await import("./duplicatePairs");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [library],
  );
  await db.q("INSERT INTO roots (path, kind, watch) VALUES ($1, 'finals', false)", [finals]);
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'pairs', $2) RETURNING id",
    [root!.id, library],
  );
  sessionId = s!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  for (const d of [library, backup, other, finals, exportsDir]) {
    await rm(d, { recursive: true, force: true });
    await mkdir(d, { recursive: true });
  }
});

after(async () => {
  if (!skipWithoutDb) {
    await db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
    await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
    await db.q("DELETE FROM sessions WHERE id = $1", [sessionId]);
    await db.q("DELETE FROM roots WHERE path = ANY($1::text[])", [[library, finals]]);
    await db.pool.end();
  }
  await rm(base, { recursive: true, force: true });
});

const exists = (p: string) => stat(p).then(() => true, () => false);
const HASH = () => `test-${randomBytes(8).toString("hex")}`;

async function asset(absPath: string, hash: string, bytes: Buffer): Promise<number> {
  await writeFile(absPath, bytes);
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, file_size, content_hash)
     VALUES ($1, $2, $3, $4, 'jpg', 'photo', $5, $6) RETURNING id`,
    [sessionId, absPath, path.basename(absPath), path.basename(absPath), bytes.length, hash],
  );
  return row!.id;
}

async function hit(absPath: string, hash: string, bytes: Buffer, assetId: number | null) {
  await writeFile(absPath, bytes);
  await db.q(
    `INSERT INTO duplicate_hits (abs_path, content_hash, existing_asset_id, source, verified, file_size)
     VALUES ($1, $2, $3, 'index', true, $4)`,
    [absPath, hash, assetId, bytes.length],
  );
}

// A library entry in `dirA` and its recorded copy in `dirB`.
async function twin(dirA: string, dirB: string, name: string): Promise<number> {
  const h = HASH();
  const bytes = randomBytes(20_000);
  const id = await asset(path.join(dirA, name), h, bytes);
  await hit(path.join(dirB, name), h, bytes, id);
  return id;
}

test("two-copy groups are aggregated by their two folders", { skip: skipWithoutDb }, async () => {
  for (const n of ["a.jpg", "b.jpg", "c.jpg"]) await twin(library, backup, n);
  await twin(finals, exportsDir, "m.jpg");
  // Not pairs: three copies, and two copies in one folder.
  const h3 = HASH();
  const b3 = randomBytes(20_000);
  const id3 = await asset(path.join(library, "t.jpg"), h3, b3);
  await hit(path.join(backup, "t.jpg"), h3, b3, id3);
  await hit(path.join(other, "t.jpg"), h3, b3, id3);
  const hs = HASH();
  const bs = randomBytes(20_000);
  await hit(path.join(other, "s.jpg"), hs, bs, null);
  await hit(path.join(other, "s (1).jpg"), hs, bs, null);

  const r = await pairs.listDuplicatePairs({ q: base });
  assert.equal(r.matched, 2);
  assert.equal(r.unpaired, 2);
  const [big, small] = r.pairs;
  assert.equal(big.groups, 3);
  assert.equal(big.bytes, 3 * 20_000);
  // The side holding the library entries is drawn on the left, and is the pick.
  assert.equal(big.left.dir, library);
  assert.equal(big.left.library, 3);
  assert.equal(big.right.dir, backup);
  assert.equal(big.suggest, "left");
  // A Final master that is the library entry: left, view-only, suggested.
  assert.equal(small.left.dir, finals);
  assert.equal(small.left.view_only, true);
  assert.equal(small.suggest, "left");
});

test("a pair's run keeps one side and touches nothing outside the pair", { skip: skipWithoutDb }, async () => {
  for (const n of ["a.jpg", "b.jpg"]) await twin(library, backup, n);
  await twin(library, other, "x.jpg");

  const r = await pairs.resolveDuplicatePair({ q: base, keepDir: library, dropDir: backup });
  assert.equal(r.resolved, 2);
  assert.equal(r.deleted, 2);
  assert.equal(r.remaining, 0);
  assert.equal(await exists(path.join(backup, "a.jpg")), false);
  assert.equal(await exists(path.join(library, "a.jpg")), true);
  assert.equal(await exists(path.join(other, "x.jpg")), true, "another pair is untouched");
});

test("keeping the side without the library entry relinks it", { skip: skipWithoutDb }, async () => {
  const id = await twin(library, other, "y.jpg");
  const r = await pairs.resolveDuplicatePair({ q: base, keepDir: other, dropDir: library });
  assert.equal(r.relinked, 1);
  const row = await db.one<{ abs_path: string }>("SELECT abs_path FROM assets WHERE id = $1", [id]);
  assert.equal(row!.abs_path, path.join(other, "y.jpg"));
  assert.equal(await exists(path.join(library, "y.jpg")), false);
});

test("a view-only side is never the one dropped", { skip: skipWithoutDb }, async () => {
  await twin(finals, exportsDir, "m.jpg");
  await assert.rejects(
    pairs.resolveDuplicatePair({ q: base, keepDir: exportsDir, dropDir: finals }),
    (e: Error) => e instanceof pairs.PairRefused,
  );
  assert.equal(await exists(path.join(finals, "m.jpg")), true);
});

test("a pair never keeps a trashed library entry as the last copy", { skip: skipWithoutDb }, async () => {
  const id = await twin(library, backup, "z.jpg");
  await db.q("UPDATE assets SET deleted_at = now() WHERE id = $1", [id]);
  const r = await pairs.resolveDuplicatePair({ q: base, keepDir: library, dropDir: backup });
  assert.equal(r.resolved, 0);
  assert.equal(await exists(path.join(backup, "z.jpg")), true, "the live copy stays");
  assert.match(r.skipped[0].reason, /trash/);
});
