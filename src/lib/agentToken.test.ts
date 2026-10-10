// Migration 0050 + lib/auth.ts: a token minted for an agent validates like any
// token (same ceiling) and says it is an agent's, which is what the proxy turns
// into `via: "agent"` and the rating routes stamp into `ratings.rated_via`.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let auth: typeof import("./auth");
let db: typeof import("./db");
let userId: number;

before(async () => {
  if (skipWithoutDb) return;
  auth = await import("./auth");
  db = await import("./db");
  const u = await db.one<{ id: number }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('agent-token-test', 'x', 'editor') RETURNING id`,
  );
  userId = u!.id;
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM users WHERE id = $1", [userId]);
  await db.pool.end();
});

test("an agent's token validates as the owner, capped, and marked as an agent", { skip: skipWithoutDb }, async () => {
  const { token, row } = await auth.createAccessToken({
    userId,
    name: "Claude",
    role: "viewer",
    agent: true,
    expiresAt: null,
    createdBy: null,
  });
  assert.equal(row.agent, true);
  const user = await auth.validateAccessToken(token);
  assert.equal(user?.id, userId);
  assert.equal(user?.role, "viewer", "the ceiling still caps an editor owner");
  assert.equal(user?.agent, true);
});

test("an app's token is not an agent's", { skip: skipWithoutDb }, async () => {
  const { token } = await auth.createAccessToken({
    userId,
    name: "Atelier",
    role: "editor",
    agent: false,
    expiresAt: null,
    createdBy: null,
  });
  const user = await auth.validateAccessToken(token);
  assert.equal(user?.role, "editor");
  assert.equal(user?.agent, false);
});

test("the via header reads 'agent' and counts as a token", { skip: skipWithoutDb }, () => {
  const h = new Headers({ [auth.HDR_AUTH_VIA]: "agent" });
  assert.equal(auth.authViaFromHeaders(h), "agent");
  assert.equal(auth.viaToken("agent"), true);
  assert.equal(auth.viaToken("token"), true);
  assert.equal(auth.viaToken("session"), false);
  assert.equal(auth.authViaFromHeaders(new Headers({ [auth.HDR_AUTH_VIA]: "robot" })), null);
});
