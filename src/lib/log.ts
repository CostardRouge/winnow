// Lightweight structured logger (zero-dependency). Replaces the scattered
// console.* calls so the worker (which runs 24/7) and the API emit consistent,
// machine-parseable logs that a collector can ship/index.
//
// Output format:
//   - "json"   : one JSON object per line ({ ts, level, scope, msg, ...fields }).
//                Default in production / when stdout is not a TTY (Docker) so a
//                log shipper can parse it.
//   - "pretty" : a compact human-readable line. Default on an interactive TTY in
//                dev (`npm run worker`, `npm run scan -- … --sync`).
//
// Configure with LOG_LEVEL (debug|info|warn|error, default info) and LOG_FORMAT
// (json|pretty). warn/error go to stderr, the rest to stdout.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const threshold =
  LEVELS[(process.env.LOG_LEVEL?.toLowerCase() as Level)] ?? LEVELS.info;

const format: "json" | "pretty" =
  process.env.LOG_FORMAT === "json" || process.env.LOG_FORMAT === "pretty"
    ? process.env.LOG_FORMAT
    : process.stdout.isTTY && process.env.NODE_ENV !== "production"
      ? "pretty"
      : "json";

export type Fields = Record<string, unknown>;

// An Error has no enumerable properties, so it would JSON-serialise to "{}".
// Normalise it (and anything else thrown) into a serialisable shape.
function serializeError(err: unknown): Fields {
  if (err instanceof Error) {
    return { err: err.message, err_type: err.name, stack: err.stack };
  }
  return { err: String(err) };
}

// `fields.err` / `fields.error` holding an Error is expanded in place so the
// message and stack survive serialisation.
function expand(fields?: Fields): Fields {
  if (!fields) return {};
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if ((k === "err" || k === "error") && v !== undefined) {
      Object.assign(out, serializeError(v));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function fmtVal(v: unknown): string {
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function write(level: Level, line: string): void {
  if (level === "warn" || level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function emit(level: Level, scope: string, msg: string, fields?: Fields): void {
  if (LEVELS[level] < threshold) return;
  const data = expand(fields);

  if (format === "json") {
    write(
      level,
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope,
        msg,
        ...data,
      }),
    );
    return;
  }

  // pretty: "HH:MM:SS.mmm LEVEL [scope] msg key=val …" (stack on its own line).
  const time = new Date().toISOString().slice(11, 23);
  const rest = Object.entries(data)
    .filter(([k]) => k !== "stack")
    .map(([k, v]) => `${k}=${fmtVal(v)}`)
    .join(" ");
  let line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (rest) line += ` ${rest}`;
  if (typeof data.stack === "string") line += `\n${data.stack}`;
  write(level, line);
}

export type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(scope: string): Logger;
};

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, fields) => emit("debug", scope, msg, fields),
    info: (msg, fields) => emit("info", scope, msg, fields),
    warn: (msg, fields) => emit("warn", scope, msg, fields),
    error: (msg, fields) => emit("error", scope, msg, fields),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger("winnow");
