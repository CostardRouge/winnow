// Winnow's MCP server: lets Claude Code (or any MCP client) drive the library
// through the agent commands (src/lib/commands/), over stdio.
//
//   claude mcp add winnow --scope user \
//     -e WINNOW_HOST=https://winnow.example -e WINNOW_TOKEN=wnw_… \
//     -- /path/to/winnow/node_modules/.bin/tsx /path/to/winnow/src/scripts/mcp.ts
//
// It is a CLIENT of the instance's API, not part of the instance: it runs on
// the agent's machine, holds one app token, and every command it runs is an
// HTTP request that src/proxy.ts checks like Atelier's or a browser's
// (docs/memory/agent-commands.md says why this shape and not an endpoint in
// Winnow). So it imports nothing that reads lib/config.ts — the instance's
// environment schema is not this process's — and its own two variables are
// the client's, read here: WINNOW_HOST (the instance's address) and
// WINNOW_TOKEN (an app token, minted on Users › App tokens, "used by an
// agent" so its writes are marked as an agent's).
//
// stdout carries the protocol and nothing else (one JSON-RPC message per
// line); anything for a person goes to stderr. Run it with tsx directly, not
// through `npm run`, which prints its banner to stdout.
import { createInterface } from "node:readline";
import { createCommandRegistry } from "../lib/commands/registry";
import { httpClient, winnowCommands } from "../lib/commands/winnow";
import { handleMessage, type JsonRpcMessage } from "../lib/commands/mcp";

const SERVER = { name: "winnow", version: "1.0.0" };

function die(message: string): never {
  process.stderr.write(`winnow-mcp: ${message}\n`);
  process.exit(1);
}

const host = process.env.WINNOW_HOST?.trim();
const token = process.env.WINNOW_TOKEN?.trim();
if (!host) die("WINNOW_HOST is not set (the instance's address, e.g. https://winnow.example)");
if (!token) die("WINNOW_TOKEN is not set (an app token from Users › App tokens, wnw_…)");
if (!token.startsWith("wnw_")) die("WINNOW_TOKEN is not a Winnow app token (they start with wnw_)");

let url: URL;
try {
  url = new URL(host);
} catch {
  die(`WINNOW_HOST is not a URL: ${host}`);
}
// The token is a key to an account: it never travels in clear past this box.
const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  die(`WINNOW_HOST must be https:// (plain http only to localhost) — got ${url.origin}`);

const registry = createCommandRegistry();
registry.register("winnow", winnowCommands(httpClient(url.origin, token)));

function send(answer: unknown) {
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}

const pending = new Set<Promise<void>>();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line) as JsonRpcMessage;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  // Requests are answered as they finish, not in arrival order: a thumbnail
  // fetch must not hold up a ping. JSON-RPC matches answers by id.
  const done = handleMessage(registry, msg, SERVER).then((answer) => {
    if (answer) send(answer);
  });
  pending.add(done);
  void done.finally(() => pending.delete(done));
});
// The client closed stdin: finish what is in flight, then leave.
rl.on("close", () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0));
});

process.stderr.write(`winnow-mcp: serving ${url.origin}\n`);
