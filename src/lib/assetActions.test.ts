// lib/assetActions.ts's bulk writes report a refused request instead of
// resolving as if it had worked: the grid's optimistic verdicts and removals
// are reverted on that throw, and "N picked" / "N deleted" is announced only
// after it. They used to ignore the status, so an expired session or a 5xx
// read as success. No database: `fetch` is stubbed.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteAssets,
  deleteAssetsByFilter,
  rateAssets,
  selectionZipUnavailable,
  tagAssets,
} from "./assetActions";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

test("a refused rating throws with the server's message", async () => {
  answer(401, { error: "Not signed in" });
  await assert.rejects(rateAssets([1, 2], { verdict: "pick" }), /Not signed in/);
});

test("a failing tag, delete or restore throws, with a status when no message came", async () => {
  answer(500, {});
  await assert.rejects(tagAssets([1], "trip", true), /tag \(500\)/);
  await assert.rejects(deleteAssets([1]), /delete \(500\)/);
  await assert.rejects(deleteAssets([1], true), /restore \(500\)/);
});

test("a failed move to the trash is an error, not '0 moved'", async () => {
  answer(503, { error: "Database unavailable" });
  await assert.rejects(deleteAssetsByFilter({ verdict: "reject" }), /Database unavailable/);
  answer(200, { updated: 12 });
  assert.equal(await deleteAssetsByFilter({ verdict: "reject" }), 12);
});

test("an accepted write resolves", async () => {
  answer(200, { updated: 2 });
  await rateAssets([1, 2], { star: 3 });
  await tagAssets([1], "trip", false);
  await deleteAssets([1, 2]);
});

test("a selection past the ZIP's limit says why instead of linking to a 400", () => {
  assert.equal(selectionZipUnavailable(1000), null);
  assert.match(selectionZipUnavailable(1001) ?? "", /Up to 1,000 files per ZIP — 1,001 selected/);
});
