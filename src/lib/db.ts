import pg from "pg";
import { config } from "./config";

// Pool Postgres partagé par l'app Next.js et les workers.
// La navigation/tri est 100 % Postgres + stockage dérivés : aucun walk FS.

// `captured_at` arrive en timestamptz : on veut des chaînes ISO, pas des Date
// locales, pour une pagination cursor stable.
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
    max: 10,
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
