// lib/sesameRole.ts + migration 0060: the `role` claim of a Sésame sign-in.
// Claim present → applied; absent → kept; not one of the three → ignored;
// the last active admin is never demoted this way. The pure parser runs
// everywhere; the rest is database-backed (WINNOW_TEST_DATABASE_URL).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let sr: typeof import("./sesameRole");
let db: typeof import("./db");
let auth: typeof import("./auth");
let a: number; // admin
let b: number; // admin, the other one
let e: number; // editor
const ids = () => [a, b, e];

before(async () => {
  sr = await import("./sesameRole");
  if (skipWithoutDb) return;
  db = await import("./db");
  auth = await import("./auth");
  const mk = async (name: string, role: string) =>
    (await db.one<{ id: number }>(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', $2) RETURNING id",
      [name, role],
    ))!.id;
  a = await mk("srole-a", "admin");
  b = await mk("srole-b", "admin");
  e = await mk("srole-e", "editor");
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  // Every test starts from: a and b admins, e an editor, and NO other active
  // admin in the scratch database (another test file's rows are disabled for
  // the duration of the count by keeping ours the only admins we touch).
  await db.q("UPDATE users SET role = 'admin', disabled = false WHERE id = ANY($1)", [[a, b]]);
  await db.q("UPDATE users SET role = 'editor', disabled = false WHERE id = $1", [e]);
  await db.q("DELETE FROM role_changes WHERE user_id = ANY($1)", [ids()]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM users WHERE id = ANY($1)", [ids()]);
  await db.pool.end();
});

const roleOf = async (id: number) => (await db.one<{ role: string }>("SELECT role FROM users WHERE id = $1", [id]))!.role;
const trail = (id: number) =>
  db.many<{ from_role: string; to_role: string; source: string; kept: string | null }>(
    "SELECT from_role, to_role, source, kept FROM role_changes WHERE user_id = $1 ORDER BY id",
    [id],
  );

test("only Winnow's three roles parse; anything else is no role", () => {
  assert.equal(sr.parseSesameRole("admin"), "admin");
  assert.equal(sr.parseSesameRole("editor"), "editor");
  assert.equal(sr.parseSesameRole("viewer"), "viewer");
  for (const bad of ["Admin", "owner", "", " viewer", 1, true, null, undefined, ["admin"], { role: "admin" }])
    assert.equal(sr.parseSesameRole(bad), null, `${JSON.stringify(bad)} must not parse`);
});

test("a valid claim is applied and recorded as set by Sésame", { skip: skipWithoutDb }, async () => {
  assert.deepEqual(await sr.applySesameRole(e, "viewer"), { outcome: "applied", from: "editor", to: "viewer" });
  assert.equal(await roleOf(e), "viewer");
  assert.deepEqual(await trail(e), [{ from_role: "editor", to_role: "viewer", source: "sesame", kept: null }]);
  assert.deepEqual(await sr.applySesameRole(e, "admin"), { outcome: "applied", from: "viewer", to: "admin" });
  assert.equal(await roleOf(e), "admin");
});

test("the same role again changes and records nothing", { skip: skipWithoutDb }, async () => {
  assert.deepEqual(await sr.applySesameRole(e, "editor"), { outcome: "same", role: "editor" });
  assert.deepEqual(await trail(e), []);
});

test("no claim keeps the Winnow role: never downgrade on absence", { skip: skipWithoutDb }, async () => {
  assert.deepEqual(await sr.applySesameRole(e, undefined), { outcome: "absent" });
  assert.deepEqual(await sr.applySesameRole(a, null), { outcome: "absent" });
  assert.equal(await roleOf(e), "editor");
  assert.equal(await roleOf(a), "admin");
  assert.deepEqual(await trail(e), []);
});

test("an invalid claim is ignored", { skip: skipWithoutDb }, async () => {
  assert.equal((await sr.applySesameRole(e, "owner")).outcome, "invalid");
  assert.equal((await sr.applySesameRole(a, "Viewer")).outcome, "invalid");
  assert.equal(await roleOf(e), "editor");
  assert.equal(await roleOf(a), "admin");
});

test("an admin is demoted while another active admin remains", { skip: skipWithoutDb }, async () => {
  // Isolate from other files' rows: only a and b may be active admins here.
  const others = await db.many<{ id: number }>(
    "UPDATE users SET disabled = true WHERE role = 'admin' AND NOT disabled AND id <> ALL($1) RETURNING id",
    [[a, b]],
  );
  try {
    assert.equal((await sr.applySesameRole(a, "editor")).outcome, "applied");
    assert.equal(await roleOf(a), "editor");
  } finally {
    await db.q("UPDATE users SET disabled = false WHERE id = ANY($1)", [others.map((o) => o.id)]);
  }
});

test("the last active admin is never demoted by a sign-in, and the refusal is recorded", { skip: skipWithoutDb }, async () => {
  const others = await db.many<{ id: number }>(
    "UPDATE users SET disabled = true WHERE role = 'admin' AND NOT disabled AND id <> $1 RETURNING id",
    [a],
  );
  try {
    assert.deepEqual(await sr.applySesameRole(a, "viewer"), { outcome: "kept_last_admin", asked: "viewer" });
    assert.equal(await roleOf(a), "admin");
    assert.deepEqual(await trail(a), [{ from_role: "admin", to_role: "viewer", source: "sesame", kept: "last_admin" }]);
  } finally {
    await db.q("UPDATE users SET disabled = false WHERE id = ANY($1)", [others.map((o) => o.id)]);
  }
});

test("a role set by Sésame reaches an open session on its next request, without signing it out", { skip: skipWithoutDb }, async () => {
  const { token } = await auth.createSession(e, "test");
  assert.equal((await auth.validateSession(token))?.role, "editor"); // now cached
  await sr.applySesameRole(e, "viewer");
  const seen = await auth.validateSession(token);
  assert.ok(seen, "the session survives the change");
  assert.equal(seen.role, "viewer", "the cached role was dropped");
  await auth.destroyUserSessions(e);
});

test("an app token's ceiling follows its owner's role down at once", { skip: skipWithoutDb }, async () => {
  const { token: clear } = await auth.createAccessToken({
    userId: e,
    name: "srole",
    role: "editor",
    agent: false,
    expiresAt: null,
    createdBy: null,
  });
  assert.equal((await auth.validateAccessToken(clear))?.role, "editor");
  await sr.applySesameRole(e, "viewer");
  assert.equal((await auth.validateAccessToken(clear))?.role, "viewer");
  await sr.applySesameRole(e, "admin");
  assert.equal((await auth.validateAccessToken(clear))?.role, "editor", "a promotion never lifts a token above its ceiling");
  await db.q("DELETE FROM access_tokens WHERE user_id = $1", [e]);
});
