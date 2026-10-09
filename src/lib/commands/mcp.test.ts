import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandRegistry } from "./registry";
import { handleMessage, PROTOCOL_VERSIONS } from "./mcp";

const SERVER = { name: "winnow", version: "test" };

function registry() {
  const reg = createCommandRegistry();
  reg.register("test", [
    { id: "app.status", title: "Status", description: "who", run: () => ({ role: "viewer" }) },
    {
      id: "cull.set",
      title: "Cull",
      description: "rate",
      params: { star: { type: "number", description: "stars", min: 0, max: 5, integer: true } },
      available: () => "this token reads only",
      run: () => null,
    },
    {
      id: "assets.look",
      title: "Look",
      description: "see",
      run: () => ({ kind: "image", mimeType: "image/webp", data: "AAAA", width: 400, height: 267, note: "#7" }),
    },
  ]);
  return reg;
}

const call = (name: string, args?: object) =>
  handleMessage(registry(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, SERVER);

test("initialize negotiates the version and announces tools", async () => {
  const a = (await handleMessage(registry(), { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } }, SERVER)) as { result: Record<string, unknown> };
  assert.equal(a.result.protocolVersion, "2025-03-26");
  assert.deepEqual(a.result.capabilities, { tools: {} });
  assert.deepEqual(a.result.serverInfo, SERVER);
  const b = (await handleMessage(registry(), { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "1999-01-01" } }, SERVER)) as { result: Record<string, unknown> };
  assert.equal(b.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test("a notification gets no answer; an unknown method a JSON-RPC error", async () => {
  assert.equal(await handleMessage(registry(), { jsonrpc: "2.0", method: "notifications/initialized" }, SERVER), null);
  assert.deepEqual(await handleMessage(registry(), { jsonrpc: "2.0", id: 9, method: "resources/list" }, SERVER), {
    jsonrpc: "2.0",
    id: 9,
    error: { code: -32601, message: "method not found: resources/list" },
  });
});

test("tools/list offers Atelier's three generic tools under Winnow's name", async () => {
  const a = (await handleMessage(registry(), { jsonrpc: "2.0", id: 2, method: "tools/list" }, SERVER)) as { result: { tools: { name: string }[] } };
  assert.deepEqual(a.result.tools.map((t) => t.name), ["winnow_status", "winnow_commands", "winnow_run"]);
});

test("winnow_commands lists schemas and why a command cannot run", async () => {
  const a = (await call("winnow_commands")) as { result: { content: { text: string }[] } };
  const list = JSON.parse(a.result.content[0].text) as { id: string; available: boolean; reason?: string; params: object }[];
  const cull = list.find((c) => c.id === "cull.set")!;
  assert.equal(cull.available, false);
  assert.equal(cull.reason, "this token reads only");
  assert.deepEqual(cull.params, {
    type: "object",
    properties: { star: { type: "integer", minimum: 0, maximum: 5, description: "stars" } },
    required: ["star"],
    additionalProperties: false,
  });
});

test("a refused command is a tool error the agent can read, not a protocol error", async () => {
  const a = (await call("winnow_run", { command: "cull.set", params: { star: 2 } })) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.equal(a.result.isError, true);
  assert.equal(a.result.content[0].text, "unavailable: this token reads only");
  const b = (await call("winnow_run", { command: "cull.set", params: { star: 2 }, dry: true })) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.match(b.result.content[0].text, /^invalid: unknown argument "dry"/);
  const c = (await call("winnow_delete")) as { result: { isError?: boolean } };
  assert.equal(c.result.isError, true);
});

test("an image result becomes an MCP image block and its note", async () => {
  const a = (await call("winnow_run", { command: "assets.look" })) as { result: { content: object[] } };
  assert.deepEqual(a.result.content, [
    { type: "image", data: "AAAA", mimeType: "image/webp" },
    { type: "text", text: "#7 — 400×267 image/webp" },
  ]);
});

test("winnow_status runs app.status", async () => {
  const a = (await call("winnow_status")) as { result: { content: { text: string }[] } };
  assert.deepEqual(JSON.parse(a.result.content[0].text), { role: "viewer" });
});
