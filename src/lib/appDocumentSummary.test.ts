// The PUT route's summary rule (lib/appDocumentSummary.ts, migration 0056).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SUMMARY_BYTES, readSummary } from "./appDocumentSummary";

test("an absent or null summary is stored as null", () => {
  assert.deepEqual(readSummary(undefined), { ok: true, summary: null });
  assert.deepEqual(readSummary(null), { ok: true, summary: null });
});

test("an object is kept as it is", () => {
  const s = { name: "Désert", pictures: 300, cover: ["a", "b"] };
  assert.deepEqual(readSummary(s), { ok: true, summary: s });
});

test("anything but an object is refused", () => {
  for (const raw of ["x", 3, true, [1, 2]]) {
    const r = readSummary(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test("a summary over the cap is refused with 413", () => {
  const r = readSummary({ blob: "x".repeat(MAX_SUMMARY_BYTES) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 413);
});
