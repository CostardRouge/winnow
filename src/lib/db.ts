import pg from "pg";
import { config } from "./config";

// Postgres pool shared by the Next.js app and the workers.
// Navigation/culling is 100% Postgres + derivatives storage: no FS walk.

// `captured_at` comes in as timestamptz: we want ISO strings, not local Date
// objects, for stable cursor pagination.
pg.types.setTypeParser(1184, (v) => v); // timestamptz
pg.types.setTypeParser(1114, (v) => v); // timestamp
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10)); // int8 -> number

declare global {
  // eslint-disable-next-line no-var
  var __winnowPool: pg.Pool | undefined;
}

export const pool: pg.Pool =
  global.__winnowPool ??
  new pg.Pool({
    connectionString: config.databaseUrl,
    // Per-process cap (DB_POOL_MAX): the app and the worker each run their own
    // pool. Size against the sum of worker concurrencies.
    max: config.dbPoolMax,
    // pg_stat_activity attribution: which process owns a connection/query.
    application_name:
      process.env.WINNOW_PROCESS === "worker" ? "winnow-worker" : "winnow-app",
    // Timeouts: prevent a pending query or an unreachable Postgres from
    // exhausting the pool and freezing all the routes.
    connectionTimeoutMillis: 5000, // fail fast if the server does not respond
    idleTimeoutMillis: 30000, // releases idle connections
    statement_timeout: 30000, // kills an overly long query on the server side
  });

if (process.env.NODE_ENV !== "production") {
  global.__winnowPool = pool;
}

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const r = await q<T>(text, params);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const r = await q<T>(text, params);
  return r.rows;
}

// Runs `fn` inside a single transaction on a dedicated connection. Everything
// else in this codebase is deliberately autocommit; reach for this only where a
// multi-statement write must be all-or-nothing (e.g. replacing a face set).
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
