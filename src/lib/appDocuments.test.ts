// Migration 0056 + lib/appDocuments.ts: a document's summary is written with
// every PUT (null included, so it never describes an older body) and the
// list asked with `fields=summary` hands it back in place of the body — the
// body only for a row that has none. Database-backed: runs only with
// WINNOW_TEST_DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let docs: typeof import("./appDocuments");
let db: typeof import("./db");
let userId: number;
const APP = "summary-test";

before(async () => {
  if (skipWithoutDb) return;
  docs = await import("./appDocuments");
  db = await import("./db");
  const u = await db.one<{ id: number }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('app-doc-summary-test', 'x', 'editor') RETURNING id`,
  );
  userId = u!.id;
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM users WHERE id = $1", [userId]);
  await db.pool.end();
});

test("the summary list carries the summary, never the body", { skip: skipWithoutDb }, async () => {
  const put = await docs.putDocument(
    userId,
    APP,
    "with-summary",
    { kind: "roll", version: 8, doc: { pictures: ["a", "b"] }, summary: { name: "Désert", pictures: 2 } },
    null,
  );
  assert.equal(put.status, "ok");
  const rows = await docs.listDocumentSummaries(userId, APP, "roll");
  const row = rows.find((r) => r.id === "with-summary")!;
  assert.deepEqual(row.summary, { name: "Désert", pictures: 2 });
  assert.equal("doc" in row, false);
  // The plain list is unchanged: the body, as always.
  const full = (await docs.listDocuments(userId, APP, "roll")).find((r) => r.id === "with-summary")!;
  assert.deepEqual(full.doc, { pictures: ["a", "b"] });
});

test("a row with no summary lists with its body", { skip: skipWithoutDb }, async () => {
  await docs.putDocument(userId, APP, "no-summary", { kind: "roll", version: 8, doc: { n: 1 }, summary: null }, null);
  const row = (await docs.listDocumentSummaries(userId, APP, "roll")).find((r) => r.id === "no-summary")!;
  assert.deepEqual(row.doc, { n: 1 });
  assert.equal("summary" in row, false);
});

test("a PUT without a summary clears the old one", { skip: skipWithoutDb }, async () => {
  const first = await docs.putDocument(
    userId,
    APP,
    "cleared",
    { kind: "roll", version: 8, doc: { n: 1 }, summary: { name: "old" } },
    null,
  );
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  const second = await docs.putDocument(userId, APP, "cleared", { kind: "roll", version: 8, doc: { n: 2 }, summary: null }, first.etag);
  assert.equal(second.status, "ok", JSON.stringify(second));
  const row = (await docs.listDocumentSummaries(userId, APP, "roll")).find((r) => r.id === "cleared")!;
  assert.deepEqual(row.doc, { n: 2 });
  assert.equal("summary" in row, false);
});
