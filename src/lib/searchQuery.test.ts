// Pins how GET /api/search reads its query string and when it says there is
// another page. Pure: no database, no ML container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET, nextOffset, readSearchQuery } from "./searchQuery";

const read = (qs: string) => readSearchQuery(new URLSearchParams(qs));

test("the text is required and bounded", () => {
  assert.deepEqual(read(""), { ok: false, error: "q (the search text) is required" });
  assert.deepEqual(read("q=%20%20"), { ok: false, error: "q (the search text) is required" });
  assert.equal(read(`q=${"a".repeat(301)}`).ok, false);
});

test("limit and offset fall back and clamp, never refuse", () => {
  assert.deepEqual(read("q=dog"), { ok: true, q: "dog", limit: DEFAULT_LIMIT, offset: 0, source: null });
  assert.deepEqual(read("q=dog&limit=5000&offset=2000"), { ok: true, q: "dog", limit: MAX_LIMIT, offset: 2000, source: null });
  assert.deepEqual(read("q=dog&limit=0&offset=-4"), { ok: true, q: "dog", limit: DEFAULT_LIMIT, offset: 0, source: null });
  assert.equal((read("q=dog&offset=x") as { offset: number }).offset, 0);
  assert.equal((read(`q=dog&offset=${MAX_OFFSET + 1}`) as { offset: number }).offset, MAX_OFFSET);
});

test("the source is a half or the whole library", () => {
  assert.equal((read("q=dog&source=gallery") as { source: string }).source, "gallery");
  assert.equal((read("q=dog&source=incoming") as { source: string }).source, "incoming");
  assert.equal((read("q=dog&source=all") as { source: null }).source, null);
});

test("a full page has a next one, a short page is the last", () => {
  assert.equal(nextOffset(0, 1000, 1000), 1000);
  assert.equal(nextOffset(1000, 1000, 1000), 2000);
  assert.equal(nextOffset(2000, 1000, 412), null);
  assert.equal(nextOffset(0, 60, 0), null);
});
