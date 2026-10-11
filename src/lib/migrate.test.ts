// The migration runner's lock (lib/migrate.ts): the worker migrates at boot
// while the compose one-shot `migrate` may run at the same moment. Two runs
// started together must apply each file exactly once, the second waiting for
// the first. Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Uses a
// throwaway migrations directory of its own, never db/migrations.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let db: typeof import("./db");
let migrate: typeof import("./migrate").migrate;
let dir: string;
const FILES = ["9901_lock_test_table.sql", "9902_lock_test_row.sql"];

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  ({ migrate } = await import("./migrate"));
  dir = await mkdtemp(path.join(os.tmpdir(), "winnow-migrate-"));
  // A plain CREATE TABLE (no IF NOT EXISTS) and a slow insert: run twice, or
  // interleaved, they fail — on "already exists" or on schema_migrations' key.
  await writeFile(path.join(dir, FILES[0]), "CREATE TABLE migrate_lock_test (n int);");
  await writeFile(
    path.join(dir, FILES[1]),
    "SELECT pg_sleep(0.3); INSERT INTO migrate_lock_test VALUES (1);",
  );
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DROP TABLE IF EXISTS migrate_lock_test");
  await db.q("DELETE FROM schema_migrations WHERE name = ANY($1)", [FILES]);
  await rm(dir, { recursive: true, force: true });
  await db.pool.end();
});

test("two runs started together apply each migration exactly once", { skip: skipWithoutDb }, async () => {
  await Promise.all([migrate({ dir }), migrate({ dir })]);
  const rows = await db.many<{ n: number }>("SELECT n FROM migrate_lock_test");
  assert.equal(rows.length, 1);
  const applied = await db.many<{ name: string }>(
    "SELECT name FROM schema_migrations WHERE name = ANY($1) ORDER BY name",
    [FILES],
  );
  assert.deepEqual(applied.map((r) => r.name), FILES);
  // And a third run, later, is a no-op.
  await migrate({ dir });
  assert.equal((await db.many("SELECT n FROM migrate_lock_test")).length, 1);
});
