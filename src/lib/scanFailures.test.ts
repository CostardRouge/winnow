// Scan failures heal themselves (cf. lib/failures.ts, lib/indexer.ts): a file
// that failed on an earlier scan and gets through the next one has its failure
// resolved by the scan itself, so Failures › Scan empties once the cause is gone
// (0048/0049 shipped unapplied and left 9 124 open rows that no rescan closed).
// A file that is GONE is closed by the complete walk that no longer meets it
// (a dedup run left 113 such rows open for good). A changed file whose new
// partial hash another asset holds is indexed, not failed on every rescan.
// And a schema error is told apart from a bad file.
// The indexer part is database-backed: runs only with WINNOW_TEST_DATABASE_URL.
// It indexes real JPEGs in an IGNORED session, so no Redis is needed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase({ GEOCODE_ENABLED: "false" });

let db: typeof import("./db");
let dir: string;
let rootId: number;
// A second root that holds no media at all: an unmounted share looks like this.
let emptyDir: string;
let emptyRootId: number;

const addRoot = async (p: string) =>
  (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [p],
  ))!.id;
const failed = (p: string, root: number) =>
  db.q(
    "INSERT INTO scan_failures (abs_path, root_id, error) VALUES ($1, $2, 'column \"device_exif\" does not exist')",
    [p, root],
  );
const open = async (p: string) =>
  (await db.one<{ resolved_at: Date | null }>(
    "SELECT resolved_at FROM scan_failures WHERE abs_path = $1",
    [p],
  ))!.resolved_at === null;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  dir = await mkdtemp(path.join(os.tmpdir(), "winnow-scanfail-"));
  rootId = await addRoot(dir);
  await db.q(
    "INSERT INTO sessions (root_id, name, source_path, ignored) VALUES ($1, 'x', $2, true)",
    [rootId, dir],
  );
  emptyDir = `${dir}-empty`;
  await mkdir(emptyDir);
  emptyRootId = await addRoot(emptyDir);
});

after(async () => {
  if (skipWithoutDb) return;
  for (const p of [dir, emptyDir]) {
    await db.q("DELETE FROM scan_failures WHERE starts_with(abs_path, $1)", [p]);
    await db.q("DELETE FROM duplicate_hits WHERE starts_with(abs_path, $1)", [p]);
  }
  await db.q(
    "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
    [rootId],
  );
  await db.q("DELETE FROM sessions WHERE root_id = $1", [rootId]);
  await db.q("DELETE FROM roots WHERE id = ANY($1)", [[rootId, emptyRootId]]);
  await rm(dir, { recursive: true, force: true });
  await rm(emptyDir, { recursive: true, force: true });
  const { closeExiftool } = await import("./extract");
  await closeExiftool();
  await db.pool.end();
});

test("a file that indexes resolves its open scan failure, and only its own", { skip: skipWithoutDb }, async () => {
  const { default: sharp } = await import("sharp");
  const { indexRoot } = await import("./indexer");
  const file = path.join(dir, "DSC00001.JPG");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3a7" } }).jpeg().toFile(file);
  // A sibling tree whose path merely STARTS like this root's: not under it.
  const sibling = `${dir}-other/DSC00002.JPG`;
  const missing = path.join(dir, "gone.JPG"); // under the root, but not on disk
  // Not met by the walk either, but its stat fails with ENOTDIR, not ENOENT:
  // an answer that does not say "gone" never closes a failure.
  const unsure = path.join(file, "DSC00003.JPG");
  for (const p of [file, sibling, missing, unsure]) await failed(p, rootId);

  const res = await indexRoot(rootId);
  assert.equal(res.failed, 0);
  assert.equal(res.inserted, 1);
  assert.equal(await open(file), false, "the file indexed: its failure is resolved");
  assert.equal(await open(sibling), true, "a sibling tree's failure is not this scan's");
  assert.equal(await open(missing), false, "a file gone from disk no longer fails");
  assert.equal(res.vanishedFailures, 1);
  assert.equal(await open(unsure), true, "only ENOENT says a file is gone");

  // Reopened, then a rescan that skips the file as unchanged resolves it too.
  await db.q("UPDATE scan_failures SET resolved_at = NULL WHERE abs_path = $1", [file]);
  const again = await indexRoot(rootId);
  assert.equal(again.skipped, 1);
  assert.equal(await open(file), false);
});

test("a walk that met no media at all closes nothing", { skip: skipWithoutDb }, async () => {
  const { indexRoot } = await import("./indexer");
  // An unmounted share is an empty mount point: every path under it is ENOENT,
  // which proves the share is away, not that its files were deleted.
  const gone = path.join(emptyDir, "DSC00009.JPG");
  await failed(gone, emptyRootId);
  const res = await indexRoot(emptyRootId);
  assert.equal(res.scanned, 0);
  assert.equal(res.vanishedFailures, 0);
  assert.equal(await open(gone), true);
});

test("a changed file whose new partial hash another asset holds is indexed, not failed", { skip: skipWithoutDb }, async () => {
  const { default: sharp } = await import("sharp");
  const { indexRoot } = await import("./indexer");
  // Two DIFFERENT files the partial hash cannot tell apart (lib/hash.ts: size +
  // first 64 KiB + last 64 KiB): what two Sony clips of the same length look
  // like once the same GPS pin is written into both (2026-10-14, the instance).
  const W = 64 * 1024;
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a37" } })
    .jpeg()
    .toBuffer();
  const body = (middle: number, tail: number) =>
    Buffer.concat([jpeg, Buffer.alloc(W - jpeg.length), Buffer.alloc(W, middle), Buffer.alloc(tail)]);
  const a = path.join(dir, "C0062.JPG");
  const b = path.join(dir, "C0059.JPG");
  await writeFile(a, body(0x11, W - 106)); // before its write-back: 106 bytes short
  await writeFile(b, body(0x22, W));
  const first = await indexRoot(rootId);
  assert.equal(first.inserted, 2);
  const row = (p: string) =>
    db.one<{ id: number; file_size: string; content_hash: string | null }>(
      "SELECT id, file_size, content_hash FROM assets WHERE abs_path = $1",
      [p],
    );
  const holder = (await row(b))!;

  await writeFile(a, body(0x11, W)); // the write-back: same size and ends as b
  const res = await indexRoot(rootId);
  assert.equal(res.failed, 0, "no 'duplicate key value violates unique constraint'");
  assert.equal(res.updated, 1);
  assert.equal(res.recovered, 1);
  const changed = (await row(a))!;
  assert.equal(Number(changed.file_size), 3 * W, "the row follows the file");
  assert.equal(changed.content_hash, null, "it steps out of the unique index, like a new file would");
  assert.equal((await row(b))!.content_hash, holder.content_hash, "the holder keeps its hash");
  const hit = await db.one<{ verified: boolean | null; existing_asset_id: string }>(
    "SELECT verified, existing_asset_id FROM duplicate_hits WHERE abs_path = $1",
    [a],
  );
  assert.equal(hit?.verified, false, "recorded as a false collision");
  assert.equal(Number(hit?.existing_asset_id), holder.id);

  // And the original is not read again: the next scan stops at the stat gate.
  const again = await indexRoot(rootId);
  assert.equal(again.updated, 0);
  assert.equal(again.failed, 0);
});

test("a schema error is the code's, not the file's", async () => {
  const { isSchemaError } = await import("./failures");
  assert.equal(isSchemaError({ code: "42703" }), true); // undefined_column
  assert.equal(isSchemaError({ code: "42P01" }), true); // undefined_table
  assert.equal(isSchemaError({ code: "22P02" }), false); // a bad value: per file
  assert.equal(isSchemaError({ code: "23505" }), false); // unique violation
  assert.equal(isSchemaError(new Error("EACCES")), false);
  assert.equal(isSchemaError(null), false);
});
