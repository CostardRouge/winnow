import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandError,
  checkParams,
  createCommandRegistry,
  paramsJsonSchema,
  type ParamSpecs,
} from "./registry";

const SPECS: ParamSpecs = {
  star: { type: "number", description: "stars", min: 0, max: 5, integer: true },
  verdict: { type: "string", description: "v", enum: ["pick", "reject"], optional: true },
  dry: { type: "boolean", description: "d", optional: true },
  tags: { type: "strings", description: "t", optional: true },
};

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof CommandError ? `${e.code}: ${e.message}` : String(e);
  }
}

test("out of range is refused, never clamped", () => {
  assert.match(code(() => checkParams(SPECS, { star: 6 }))!, /^invalid: "star" is 6, above its maximum 5/);
  assert.match(code(() => checkParams(SPECS, { star: -1 }))!, /below its minimum 0/);
  assert.match(code(() => checkParams(SPECS, { star: 2.5 }))!, /whole number/);
});

test("an unknown key is refused naming the known ones", () => {
  assert.match(
    code(() => checkParams(SPECS, { star: 1, stars: 2 }))!,
    /unknown parameter "stars" — this command takes star, verdict, dry, tags/,
  );
  assert.match(code(() => checkParams(undefined, { x: 1 }))!, /takes none/);
});

test("missing, enum and type errors name the field", () => {
  assert.match(code(() => checkParams(SPECS, {}))!, /missing parameter "star"/);
  assert.match(code(() => checkParams(SPECS, { star: 1, verdict: "keep" }))!, /one of "pick", "reject"/);
  assert.match(code(() => checkParams(SPECS, { star: 1, dry: "yes" }))!, /true or false/);
  assert.match(code(() => checkParams(SPECS, { star: 1, tags: [1] }))!, /list of strings/);
  assert.match(code(() => checkParams(SPECS, [1]))!, /params must be an object/);
});

test("valid params pass through, optional nulls dropped", () => {
  assert.deepEqual(checkParams(SPECS, { star: 3, verdict: null }), { star: 3 });
});

test("the JSON Schema states bounds, enums and required fields", () => {
  assert.deepEqual(paramsJsonSchema(SPECS), {
    type: "object",
    properties: {
      star: { type: "integer", minimum: 0, maximum: 5, description: "stars" },
      verdict: { type: "string", enum: ["pick", "reject"], description: "v" },
      dry: { type: "boolean", description: "d" },
      tags: { type: "array", items: { type: "string" }, description: "t" },
    },
    required: ["star"],
    additionalProperties: false,
  });
  assert.deepEqual(paramsJsonSchema(undefined), {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("execute: unknown, unavailable (with the reason), invalid, failed", async () => {
  const reg = createCommandRegistry();
  reg.register("test", [
    { id: "cull.set", title: "", description: "", params: SPECS, run: (p) => ({ ok: p.star }) },
    { id: "cull.locked", title: "", description: "", available: async () => "this token is read-only", run: () => 1 },
    { id: "cull.boom", title: "", description: "", run: () => { throw new Error("HTTP 500"); } },
  ]);
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: CommandError) => `${e.code}: ${e.message}`,
    );
  assert.match((await err(reg.execute("cull.nope")))!, /^unknown: .*in that group: cull\.boom, cull\.locked, cull\.set/);
  assert.equal(await err(reg.execute("cull.locked")), "unavailable: this token is read-only");
  assert.match((await err(reg.execute("cull.set", { star: 9 })))!, /^invalid/);
  assert.equal(await err(reg.execute("cull.boom")), "failed: HTTP 500");
  assert.deepEqual(await reg.execute("cull.set", { star: 4 }), { ok: 4 });

  const listed = await reg.list();
  assert.deepEqual(
    listed.map((c) => [c.id, c.available, c.reason]),
    [
      ["cull.boom", true, undefined],
      ["cull.locked", false, "this token is read-only"],
      ["cull.set", true, undefined],
    ],
  );
});

test("the latest registration of an id wins, the earlier one comes back", async () => {
  const reg = createCommandRegistry();
  reg.register("a", [{ id: "x.y", title: "", description: "", run: () => "a" }]);
  const off = reg.register("b", [{ id: "x.y", title: "", description: "", run: () => "b" }]);
  assert.equal(await reg.execute("x.y"), "b");
  off();
  assert.equal(await reg.execute("x.y"), "a");
});

test("a list of numbers is checked item by item and capped", () => {
  const ids: ParamSpecs = {
    ids: { type: "numbers", description: "ids", integer: true, min: 1, maxItems: 3 },
  };
  assert.deepEqual(checkParams(ids, { ids: [1, 2] }), { ids: [1, 2] });
  assert.match(code(() => checkParams(ids, { ids: [] }))!, /non-empty list/);
  assert.match(code(() => checkParams(ids, { ids: [1, 2, 3, 4] }))!, /holds 4 items — 3 at most/);
  assert.match(code(() => checkParams(ids, { ids: [1, 0] }))!, /"ids\[1\]" is 0, below its minimum 1/);
  assert.match(code(() => checkParams(ids, { ids: [1.5] }))!, /"ids\[0\]" must be a whole number/);
  assert.match(code(() => checkParams(ids, { ids: ["7"] }))!, /must be a finite number/);
  assert.deepEqual(paramsJsonSchema(ids).properties, {
    ids: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "integer", minimum: 1 },
      description: "ids",
    },
  });
});
