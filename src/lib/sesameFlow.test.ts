// lib/sesameFlow.ts: the signed cookie that carries the round trip to Sésame,
// the `next` path and the origin behind the proxy. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { originFrom, readFlow, safeNext, signFlow, type SesameFlow } from "./sesameFlow";

const flow: SesameFlow = { state: "s", verifier: "v", next: "/library/x", intent: "login", exp: 2_000 };

test("a flow reads back with the secret that signed it, and not after it expires", () => {
  const raw = signFlow(flow, "secret");
  assert.deepEqual(readFlow(raw, "secret", 1_000), flow);
  assert.equal(readFlow(raw, "secret", 2_001), null, "expired");
  assert.equal(readFlow(raw, "another", 1_000), null, "another key");
});

test("a forged or edited flow is refused", () => {
  const raw = signFlow(flow, "secret");
  const [payload, sig] = raw.split(".");
  const edited = Buffer.from(JSON.stringify({ ...flow, intent: "link" })).toString("base64url");
  assert.equal(readFlow(`${edited}.${sig}`, "secret", 1_000), null);
  assert.equal(readFlow(`${payload}.`, "secret", 1_000), null);
  assert.equal(readFlow("nonsense", "secret", 1_000), null);
  assert.equal(readFlow(undefined, "secret", 1_000), null);
});

test("next is a path on this site, nothing else", () => {
  assert.equal(safeNext("/sessions/12"), "/sessions/12");
  assert.equal(safeNext("//evil.example"), "/library");
  assert.equal(safeNext("/\\evil.example"), "/library");
  assert.equal(safeNext("https://evil.example"), "/library");
  assert.equal(safeNext(null), "/library");
  // A flow whose next was tampered before signing still lands at home.
  const raw = signFlow({ ...flow, next: "//evil.example" }, "k");
  assert.equal(readFlow(raw, "k", 1_000)?.next, "/library");
});

test("the origin is the one the browser used, behind Traefik", () => {
  const h = new Headers({ host: "winnow.steeve.website", "x-forwarded-proto": "https" });
  assert.equal(originFrom(h, "http://0.0.0.0:3000"), "https://winnow.steeve.website");
  assert.equal(originFrom(new Headers({ host: "localhost:3000" }), "http://localhost:3000"), "http://localhost:3000");
  assert.equal(originFrom(new Headers(), "http://localhost:3000"), "http://localhost:3000");
});
