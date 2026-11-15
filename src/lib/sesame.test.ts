// Migration 0059 + lib/sesame.ts: a Sésame identity links to ONE account,
// found by its `sub` (never by email), and unlinking removes only that door.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let sesame: typeof import("./sesame");
let db: typeof import("./db");
let a: number;
let b: number;

before(async () => {
  if (skipWithoutDb) return;
  sesame = await import("./sesame");
  db = await import("./db");
  a = (await db.one<{ id: number }>(
    "INSERT INTO users (username, password_hash, role) VALUES ('sesame-a', 'x', 'editor') RETURNING id",
  ))!.id;
  b = (await db.one<{ id: number }>(
    "INSERT INTO users (username, password_hash, role) VALUES ('sesame-b', 'x', 'viewer') RETURNING id",
  ))!.id;
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM users WHERE id = ANY($1)", [[a, b]]);
  await db.pool.end();
});

test("a Sésame identity links to one account and finds it again", { skip: skipWithoutDb }, async () => {
  assert.equal(await sesame.userBySesameSub("sub-1"), null);
  assert.equal(await sesame.linkSesame(a, "sub-1"), "linked");
  assert.deepEqual(await sesame.userBySesameSub("sub-1"), { id: a, disabled: false });
  assert.equal(await sesame.sesameLinked(a), true);
  assert.equal(await sesame.linkSesame(a, "sub-1"), "linked", "linking again is harmless");
});

test("an identity linked to one account cannot be linked to another", { skip: skipWithoutDb }, async () => {
  assert.equal(await sesame.linkSesame(b, "sub-1"), "taken");
  assert.equal(await sesame.sesameLinked(b), false);
  assert.equal((await sesame.userBySesameSub("sub-1"))?.id, a);
});

test("unlinking removes the door and frees the identity", { skip: skipWithoutDb }, async () => {
  await sesame.unlinkSesame(a);
  assert.equal(await sesame.userBySesameSub("sub-1"), null);
  assert.equal(await sesame.linkSesame(b, "sub-1"), "linked");
});
