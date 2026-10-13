// lib/sidecars.ts against a real database and a real folder: a clip moved to
// another folder keeps ONE set of sidecar rows — the ones its new folder holds —
// and the rows of the folder it left are dropped, by recordSidecars going
// forward and by migration 0054 for what had already accumulated. The case is
// the maintainer's: 263 .SRT rows for 156 drone clips, the dead ones listed
// first. Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Invented
// fixtures in a temporary folder; no original is involved.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let db: typeof import("./db");
let sc: typeof import("./sidecars");
let root: string;
let rootId: number;
let sessionId: number;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  sc = await import("./sidecars");
  root = await mkdtemp(path.join(os.tmpdir(), "winnow-sidecars-"));
  const r = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [root],
  );
  rootId = Number(r!.id);
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'august', $2) RETURNING id",
    [rootId, root],
  );
  sessionId = Number(s!.id);
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await rm(root, { recursive: true, force: true });
  await db.pool.end();
});

/** A clip filed at `rel`, with its .SRT beside it on disk. */
async function clip(rel: string): Promise<{ id: number; abs: string }> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, "mp4");
  await writeFile(abs.replace(/\.MP4$/, ".SRT"), "1\n00:00:00,000 --> 00:00:00,033\n");
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, captured_at)
     VALUES ($1, $2, $3, $4, '.mp4', 'video', '2026-08-14T02:37:40Z') RETURNING id`,
    [sessionId, abs, rel, path.basename(abs)],
  );
  return { id: Number(row!.id), abs };
}

/** A row of the folder the clip was moved out of — its file is not there. */
async function leftBehind(assetId: number, rel: string): Promise<void> {
  await db.q(
    `INSERT INTO asset_sidecars (asset_id, abs_path, rel_path, filename, kind)
     VALUES ($1, $2, $3, $4, 'srt')`,
    [assetId, path.join(root, rel), rel, path.basename(rel)],
  );
}

const rows = (assetId: number) =>
  db.many<{ abs_path: string }>(
    "SELECT abs_path FROM asset_sidecars WHERE asset_id = $1 ORDER BY id",
    [assetId],
  );

test("recording a moved clip's sidecars drops the rows of the folder it left", { skip: skipWithoutDb }, async () => {
  const c = await clip("bretagne 2026/DJI_20260814023740_0007_D.MP4");
  await leftBehind(c.id, "DJI_20260814023740_0007_D.SRT");

  const res = await sc.recordSidecars({ assetId: c.id, absPath: c.abs, rootPath: root });
  assert.equal(res.recorded, 1);
  assert.equal(res.pruned, 1);
  assert.deepEqual(
    (await rows(c.id)).map((r) => r.abs_path),
    [c.abs.replace(/\.MP4$/, ".SRT")],
  );

  // Recording again changes nothing: the live row is kept, nothing is pruned.
  const again = await sc.recordSidecars({ assetId: c.id, absPath: c.abs, rootPath: root });
  assert.equal(again.pruned, 0);
  assert.equal((await rows(c.id)).length, 1);
});

test("an unreadable folder prunes nothing", { skip: skipWithoutDb }, async () => {
  const c = await clip("june/DJI_20260614071310_0013_D.MP4");
  await leftBehind(c.id, "DJI_20260614071310_0013_D.SRT");
  const res = await sc.recordSidecars({
    assetId: c.id,
    absPath: path.join(root, "nowhere", "DJI_20260614071310_0013_D.MP4"),
    rootPath: root,
  });
  assert.deepEqual({ recorded: res.recorded, pruned: res.pruned }, { recorded: 0, pruned: 0 });
  assert.equal((await rows(c.id)).length, 1);
});

test("migration 0054 drops every row outside its clip's folder, and only those", { skip: skipWithoutDb }, async () => {
  const moved = await clip("vieux habitants/DJI_20260529233302_0155_D.MP4");
  await sc.recordSidecars({ assetId: moved.id, absPath: moved.abs, rootPath: root });
  await leftBehind(moved.id, "DJI_20260529233302_0155_D.SRT");
  const still = await clip("DJI_20260530003352_0160_D.MP4");
  await sc.recordSidecars({ assetId: still.id, absPath: still.abs, rootPath: root });
  assert.equal((await rows(moved.id)).length, 2);

  const sql = await readFile(
    path.join(process.cwd(), "db/migrations/0054_sidecars_left_behind.sql"),
    "utf8",
  );
  await db.q(sql);
  assert.deepEqual(
    (await rows(moved.id)).map((r) => r.abs_path),
    [moved.abs.replace(/\.MP4$/, ".SRT")],
  );
  assert.deepEqual(
    (await rows(still.id)).map((r) => r.abs_path),
    [still.abs.replace(/\.MP4$/, ".SRT")],
  );
  // Idempotent: a second run finds nothing to drop.
  await db.q(sql);
  assert.equal((await rows(moved.id)).length, 1);
});
