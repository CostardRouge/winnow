// lib/assetChanges.ts: the page-wide notice that keeps the viewer's copy of a
// burst frame in step with the writes made on it. Pure, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAssetChange } from "./assetChanges";

const pile = [
  { id: 1, verdict: "unrated" },
  { id: 2, verdict: "unrated" },
  { id: 3, verdict: "unrated" },
];

test("a patch changes the named frames only — never the rest of the pile", () => {
  const next = applyAssetChange(pile, { ids: [2], patch: () => ({ verdict: "pick" }) });
  assert.deepEqual(
    next.map((r) => r.verdict),
    ["unrated", "pick", "unrated"],
  );
  assert.equal(next[0], pile[0]);
});

test("a change that names no frame of the list, or carries no patch, returns the same array", () => {
  assert.equal(applyAssetChange(pile, { ids: [9], patch: () => ({ verdict: "pick" }) }), pile);
  assert.equal(applyAssetChange(pile, { ids: [1] }), pile);
});

test("a patch reads the row it changes (a tag added to what the frame holds)", () => {
  const rows = [{ id: 1, tags: ["b"] }];
  const next = applyAssetChange(rows, {
    ids: [1],
    patch: (r) => ({ tags: [...(r.tags ?? []), "a"].sort() }),
  });
  assert.deepEqual(next[0].tags, ["a", "b"]);
});
