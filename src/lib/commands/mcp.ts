// The MCP half of the command registry: JSON-RPC messages in, JSON-RPC
// answers out, over whatever transport the caller wires (`src/scripts/mcp.ts`
// wires stdio). Pure — no I/O, no environment — so the protocol is tested
// without a process.
//
// Three generic tools, the same three Atelier's bridge offers
// (`atelier_status`, `atelier_commands`, `atelier_run`), so an agent driving
// both meets one vocabulary:
//   winnow_status   → the `app.status` command (who, which role, what is on);
//   winnow_commands → every command with its JSON Schema and availability;
//   winnow_run      → { command, params } through the registry's one door.
// Generic rather than one MCP tool per command because that is the shared
// convention, and because a command's availability (a read-only token, the
// Timeline off) is part of its listing, which a static tool list cannot say.
//
// A command's JSON answer becomes a text block; an `ImageResult` becomes an
// MCP image block (the agent SEES it) followed by its note. A `CommandError`
// is a tool result with `isError` and its code, never a JSON-RPC error: the
// agent must read "unavailable: this token reads only…" and adapt, which a
// protocol error would hide from it.
import {
  CommandError,
  isImageResult,
  paramsJsonSchema,
  type CommandRegistry,
} from "./registry";

// Versions this server speaks; it answers the client's when it is one of
// them, else the newest (the spec's negotiation rule).
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcAnswer =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const INSTRUCTIONS = `Winnow is a photographer's ingest → cull → export library (RAW photos and videos on a home NAS). You act as one account through an app token: call winnow_status first, then winnow_commands for what you may do, and winnow_run to do it. Days are the place's local capture days. Culling is a verdict (pick / reject / skip / unrated), 0–5 stars and a colour label; a RAW+JPEG pair is rated as one. Look at a picture (assets.look) before judging it. Writes need an editor token and are marked as an agent's when the token was minted for one; the originals are never touched.`;

export function mcpTools() {
  return [
    {
      name: "winnow_status",
      description:
        "Who you are on this Winnow instance: the account the token acts as, the role it runs as (viewer reads, editor may also cull), whether your writes are marked as an agent's, and which optional readings (the Timeline) are on. Call it first.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "winnow_commands",
      description:
        "Every Winnow command: its id, what it does, its parameters as JSON Schema, and whether it can run now (with the reason when it cannot). Read it before winnow_run.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "winnow_run",
      description:
        "Run one Winnow command by id with its parameters, e.g. {\"command\": \"assets.list\", \"params\": {\"day\": \"2025-01-04\"}}. Parameters are checked: an out-of-range value or an unknown key is refused with the field named, never clamped or ignored. A picture comes back as an image.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "A command id from winnow_commands, e.g. cull.set" },
          params: { type: "object", description: "The command's parameters (its JSON Schema in winnow_commands)" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ];
}

function toContent(value: unknown): Content[] {
  if (isImageResult(value)) {
    return [
      { type: "image", data: value.data, mimeType: value.mimeType },
      {
        type: "text",
        text: `${value.note ? `${value.note} — ` : ""}${value.width}×${value.height} ${value.mimeType}`,
      },
    ];
  }
  return [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }];
}

async function callTool(
  registry: CommandRegistry,
  name: unknown,
  args: Record<string, unknown>,
): Promise<{ content: Content[]; isError?: true }> {
  try {
    switch (name) {
      case "winnow_status":
        return { content: toContent(await registry.execute("app.status")) };
      case "winnow_commands": {
        const list = await registry.list();
        return {
          content: toContent(
            list.map((c) => ({
              id: c.id,
              title: c.title,
              description: c.description,
              params: paramsJsonSchema(c.params),
              available: c.available,
              ...(c.reason ? { reason: c.reason } : {}),
            })),
          ),
        };
      }
      case "winnow_run": {
        const command = args.command;
        if (typeof command !== "string")
          throw new CommandError("invalid", `"command" must be a command id, e.g. "assets.list"`);
        for (const key of Object.keys(args))
          if (key !== "command" && key !== "params")
            throw new CommandError("invalid", `unknown argument "${key}" — winnow_run takes command, params`);
        return { content: toContent(await registry.execute(command, args.params)) };
      }
      default:
        throw new CommandError("unknown", `no tool "${String(name)}" — winnow_status, winnow_commands, winnow_run`);
    }
  } catch (err) {
    const msg =
      err instanceof CommandError
        ? `${err.code}: ${err.message}`
        : `failed: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

/**
 * One incoming message → its answer, or null for a notification (no id).
 * Never throws: whatever goes wrong becomes a JSON-RPC error or a tool error.
 */
export async function handleMessage(
  registry: CommandRegistry,
  msg: JsonRpcMessage,
  server: { name: string; version: string },
): Promise<JsonRpcAnswer | null> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  const id = isRequest ? (msg.id as string | number) : null;
  const ok = (result: unknown): JsonRpcAnswer => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcAnswer => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  if (typeof msg.method !== "string") return isRequest ? fail(-32600, "invalid request") : null;
  // Notifications (initialized, cancelled…) need no answer, and none is sent.
  if (!isRequest) return null;

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(asked as (typeof PROTOCOL_VERSIONS)[number])
        ? asked
        : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: server,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: mcpTools() });
    case "tools/call": {
      const p = msg.params ?? {};
      const args = p.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args)))
        return fail(-32602, "arguments must be an object");
      return ok(await callTool(registry, p.name, (args as Record<string, unknown>) ?? {}));
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}
