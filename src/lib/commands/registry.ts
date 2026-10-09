// The COMMAND REGISTRY: everything an agent may do to the library, named once —
// an id, its parameters, whether it can run now and what it does — and run
// through ONE door, `execute`.
//
// The idea is LightCraft's (`storytold/lightcraft`, `crates/engine`): every
// gesture is a command with a stable id and JSON parameters, and the UI, a
// script and an MCP client dispatch through the same entry point. The SHAPES
// here are Atelier's (`src/shared/commands/registry.ts` there), on purpose:
// the maintainer's three projects (Atelier, Winnow, p5-templates) answer an
// agent with the same ids, the same parameter subset, the same error codes and
// the same picture result, so an agent that learnt one has learnt them all.
//
// What differs, and why:
//   - `available()` may answer a PROMISE. Atelier's commands close over a
//     mounted screen and know at once; Winnow's close over an HTTP client and
//     may have to ask the instance (is the Timeline on? is this token allowed
//     to write?). So `list()` is async too.
//   - No `subscribe` / `waitForCommand`: nothing mounts or unmounts here, the
//     set of commands is fixed for the life of the process.
//
// A command's `run` calls the very API route the UI's gesture calls
// (`./winnow.ts`), so it is validated, authorized and attributed by the
// server exactly like a human's — the registry checks shapes, never rights.
//
// Pure and dependency-free: the MCP server (`src/scripts/mcp.ts`) imports it
// without pulling in lib/config.ts, which needs the instance's environment.

/** One parameter's shape. */
export type ParamSpec =
  | {
      type: "number";
      description: string;
      min?: number;
      max?: number;
      integer?: boolean;
      optional?: boolean;
    }
  | { type: "string"; description: string; enum?: readonly string[]; optional?: boolean }
  | { type: "boolean"; description: string; optional?: boolean }
  | { type: "strings"; description: string; optional?: boolean }
  | { type: "object"; description: string; optional?: boolean };

export type ParamSpecs = Readonly<Record<string, ParamSpec>>;

/** What a command may answer with besides plain JSON: a picture to LOOK at. */
export interface ImageResult {
  kind: "image";
  // WebP is Winnow's derivative format (lib/derivatives.ts) and MCP clients
  // take it as is; Atelier answers JPEG/PNG. Same field, one more value.
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** Base64, no `data:` prefix. */
  data: string;
  width: number;
  height: number;
  /** What the picture is — said beside it to the agent. */
  note?: string;
}

export type Availability = true | string;

export interface CommandSpec {
  /** Dotted and stable: `cull.set`, `app.status`. A script outlives a label. */
  id: string;
  /** A few words for a person. */
  title: string;
  /** What it does and what it answers, for the agent choosing it. */
  description: string;
  params?: ParamSpecs;
  /** `true` when it can run now, else the reason it cannot. Absent = always. */
  available?: () => Availability | Promise<Availability>;
  run: (params: Record<string, unknown>) => unknown;
}

/** A command as listed: no function, everything an agent needs to call it. */
export interface CommandInfo {
  id: string;
  title: string;
  description: string;
  params: ParamSpecs;
  available: boolean;
  /** Why not, when not. */
  reason?: string;
}

export type CommandErrorCode = "unknown" | "unavailable" | "invalid" | "failed";

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export interface CommandRegistry {
  /**
   * Register `specs` under `owner` — a module's name, for the logs — and
   * answer the function that takes them back. Two owners may register the
   * same id: the LATEST wins while it lives.
   */
  register: (owner: string, specs: readonly CommandSpec[]) => () => void;
  list: () => Promise<CommandInfo[]>;
  /** Check the parameters, then run. Rejects with a `CommandError`. */
  execute: (id: string, params?: unknown) => Promise<unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The parameters as `run` receives them: every declared field checked, a
 * number out of its bounds REFUSED rather than clamped (an agent asking for
 * six stars should hear that the scale ends at 5), unknown fields refused —
 * a misspelt key that silently did nothing is the failure an agent cannot
 * see. Throws `CommandError('invalid')` naming the field.
 */
export function checkParams(
  specs: ParamSpecs | undefined,
  raw: unknown,
): Record<string, unknown> {
  const given = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(given)) throw new CommandError("invalid", "params must be an object");
  const declared = specs ?? {};
  for (const key of Object.keys(given)) {
    if (!(key in declared)) {
      const known = Object.keys(declared);
      throw new CommandError(
        "invalid",
        `unknown parameter "${key}"${known.length ? ` — this command takes ${known.join(", ")}` : " — this command takes none"}`,
      );
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(declared)) {
    const v = given[key];
    if (v === undefined || v === null) {
      if (!spec.optional) throw new CommandError("invalid", `missing parameter "${key}"`);
      continue;
    }
    switch (spec.type) {
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v))
          throw new CommandError("invalid", `"${key}" must be a finite number`);
        if (spec.integer && !Number.isInteger(v))
          throw new CommandError("invalid", `"${key}" must be a whole number`);
        if (spec.min !== undefined && v < spec.min)
          throw new CommandError("invalid", `"${key}" is ${v}, below its minimum ${spec.min}`);
        if (spec.max !== undefined && v > spec.max)
          throw new CommandError("invalid", `"${key}" is ${v}, above its maximum ${spec.max}`);
        break;
      case "string":
        if (typeof v !== "string") throw new CommandError("invalid", `"${key}" must be a string`);
        if (spec.enum && !spec.enum.includes(v)) {
          throw new CommandError(
            "invalid",
            `"${key}" is "${v}" — one of ${spec.enum.map((e) => `"${e}"`).join(", ")}`,
          );
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") throw new CommandError("invalid", `"${key}" must be true or false`);
        break;
      case "strings":
        if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
          throw new CommandError("invalid", `"${key}" must be a list of strings`);
        }
        break;
      case "object":
        if (!isRecord(v)) throw new CommandError("invalid", `"${key}" must be an object`);
        break;
    }
    out[key] = v;
  }
  return out;
}

/**
 * The parameters as a JSON Schema object — what an MCP client is handed as a
 * tool's input schema.
 */
export function paramsJsonSchema(specs: ParamSpecs | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(specs ?? {})) {
    let prop: Record<string, unknown>;
    switch (spec.type) {
      case "number":
        prop = {
          type: spec.integer ? "integer" : "number",
          ...(spec.min !== undefined ? { minimum: spec.min } : {}),
          ...(spec.max !== undefined ? { maximum: spec.max } : {}),
        };
        break;
      case "string":
        prop = { type: "string", ...(spec.enum ? { enum: [...spec.enum] } : {}) };
        break;
      case "boolean":
        prop = { type: "boolean" };
        break;
      case "strings":
        prop = { type: "array", items: { type: "string" } };
        break;
      case "object":
        prop = { type: "object" };
        break;
    }
    properties[key] = { ...prop, description: spec.description };
    if (!spec.optional) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

async function availability(spec: CommandSpec): Promise<Availability> {
  try {
    return spec.available ? await spec.available() : true;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function isImageResult(v: unknown): v is ImageResult {
  return isRecord(v) && v.kind === "image" && typeof v.data === "string";
}

type Entry = { owner: string; spec: CommandSpec; token: object };

export function createCommandRegistry(): CommandRegistry {
  // Per id, the registrations in the order they came: the last one is live.
  const byId = new Map<string, Entry[]>();

  function live(id: string): Entry | null {
    const stack = byId.get(id);
    return stack && stack.length ? stack[stack.length - 1] : null;
  }

  return {
    register(owner, specs) {
      const token = {};
      for (const spec of specs) {
        const stack = byId.get(spec.id) ?? [];
        stack.push({ owner, spec, token });
        byId.set(spec.id, stack);
      }
      return () => {
        for (const spec of specs) {
          const stack = byId.get(spec.id);
          if (!stack) continue;
          const i = stack.findIndex((e) => e.token === token);
          if (i >= 0) stack.splice(i, 1);
          if (stack.length === 0) byId.delete(spec.id);
        }
      };
    },

    async list() {
      const ids = [...byId.keys()].sort();
      const infos = await Promise.all(
        ids.map(async (id): Promise<CommandInfo | null> => {
          const e = live(id);
          if (!e) return null;
          const a = await availability(e.spec);
          const info: CommandInfo = {
            id,
            title: e.spec.title,
            description: e.spec.description,
            params: e.spec.params ?? {},
            available: a === true,
          };
          if (a !== true) info.reason = a;
          return info;
        }),
      );
      return infos.filter((i): i is CommandInfo => i !== null);
    },

    async execute(id, raw) {
      const e = live(id);
      if (!e) {
        const near = [...byId.keys()].filter((k) => k.split(".")[0] === id.split(".")[0]);
        throw new CommandError(
          "unknown",
          `no command "${id}"${near.length ? ` — in that group: ${near.sort().join(", ")}` : ""}`,
        );
      }
      const a = await availability(e.spec);
      if (a !== true) throw new CommandError("unavailable", a);
      const params = checkParams(e.spec.params, raw);
      try {
        return await e.spec.run(params);
      } catch (err) {
        if (err instanceof CommandError) throw err;
        throw new CommandError("failed", err instanceof Error ? err.message : String(err));
      }
    },
  };
}
