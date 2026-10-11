// Scan failures heal themselves (cf. lib/failures.ts, lib/indexer.ts): a file
// that failed on an earlier scan and gets through the next one has its failure
// resolved by the scan itself, so Failures › Scan empties once the cause is gone
// (0048/0049 shipped unapplied and left 9 124 open rows that no rescan closed).
// And a schema error is told apart from a bad file.
// The indexer part is database-backed: runs only with WINNOW_TEST_DATABASE_URL.
// It indexes a real JPEG in an IGNORED session, so no Redis is needed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase({ GEOCODE_ENABLED: "false" });

let db: typeof import("./db");
let dir: string;
let rootId: number;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  dir = await mkdtemp(path.join(os.tmpdir(), "winnow-scanfail-"));
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [dir],
  ))!.id;
  await db.q(
    "INSERT INTO sessions (root_id, name, source_path, ignored) VALUES ($1, 'x', $2, true)",
    [rootId, dir],
  );
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM scan_failures WHERE starts_with(abs_path, $1)", [dir]);
  await db.q(
    "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
    [rootId],
  );
  await db.q("DELETE FROM sessions WHERE root_id = $1", [rootId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await rm(dir, { recursive: true, force: true });
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
  for (const p of [file, sibling, missing]) {
    await db.q(
      "INSERT INTO scan_failures (abs_path, root_id, error) VALUES ($1, $2, 'column \"device_exif\" does not exist')",
      [p, rootId],
    );
  }
  const open = async (p: string) =>
    (await db.one<{ resolved_at: Date | null }>(
      "SELECT resolved_at FROM scan_failures WHERE abs_path = $1",
      [p],
    ))!.resolved_at === null;

  const res = await indexRoot(rootId);
  assert.equal(res.failed, 0);
  assert.equal(res.inserted, 1);
  assert.equal(await open(file), false, "the file indexed: its failure is resolved");
  assert.equal(await open(sibling), true, "a sibling tree's failure is not this scan's");
  assert.equal(await open(missing), true, "a file the walk never saw stays open");

  // Reopened, then a rescan that skips the file as unchanged resolves it too.
  await db.q("UPDATE scan_failures SET resolved_at = NULL WHERE abs_path = $1", [file]);
  const again = await indexRoot(rootId);
  assert.equal(again.skipped, 1);
  assert.equal(await open(file), false);
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
