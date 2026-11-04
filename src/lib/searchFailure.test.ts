// Pins what the Search page says for each way /api/search can fail, including
// the gateway's HTML page that replaced Winnow's own 502 on the Optiplex.
// Pure: no database, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson, searchFailureMessage } from "./searchFailure";

const CLOUDFLARE_502 = '<!DOCTYPE html><html><head><title>winnow.example | 502: Bad gateway</title></head><body>…</body></html>';

test("a gateway's HTML page is not JSON, and says the ML did not answer in time", () => {
  assert.equal(readJson(CLOUDFLARE_502), null);
  const msg = searchFailureMessage(502, CLOUDFLARE_502);
  assert.match(msg, /HTTP 502/);
  assert.match(msg, /ML container did not answer in time/);
  assert.match(msg, /ML_BASE_URL/);
  assert.match(searchFailureMessage(524, ""), /HTTP 524/);
});

test("Winnow's own embedding failure names the ML container and its detail", () => {
  const msg = searchFailureMessage(502, JSON.stringify({ error: "embedding failed", detail: "ml HTTP 404 from http://ml:3003/predict" }));
  assert.match(msg, /^The ML container could not read the words \(ml HTTP 404 from http:\/\/ml:3003\/predict\)/);
});

test("any other answer keeps its own words, or its status", () => {
  assert.equal(searchFailureMessage(400, JSON.stringify({ error: "q is too long (max 300 chars)" })), "q is too long (max 300 chars)");
  assert.equal(searchFailureMessage(500, JSON.stringify({})), "Search failed (HTTP 500).");
  assert.equal(searchFailureMessage(418, "teapot"), "Search failed (HTTP 418).");
  assert.equal(readJson("[1,2]"), null);
});
