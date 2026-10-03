// Database access for tests — opt-in, and never the shell's own database.
//
// A test that inserts rows must not be able to land them in a real library, so
// the database comes from a variable of its own, WINNOW_TEST_DATABASE_URL, and
// never from whatever DATABASE_URL happens to be exported (a dev database, or
// the production one inside a container). Without it, database tests skip and
// say why. Test-only: no app, worker or script module imports this file, which
// is why it may read process.env outside lib/config.ts.

export const testDatabaseUrl =
  process.env.WINNOW_TEST_DATABASE_URL?.trim() || null;

/** Pass as `{ skip: skipWithoutDb }` to a database test. */
export const skipWithoutDb: string | false = testDatabaseUrl
  ? false
  : "set WINNOW_TEST_DATABASE_URL to a migrated scratch database to run this";

/**
 * Points the app's configuration at the test database (plus any extra
 * variables the test needs). Call it BEFORE importing a module that reads
 * lib/config.ts — the environment is parsed once, at import — which in practice
 * means: call this, then `await import(...)` the module under test.
 */
export function useTestDatabase(extraEnv: Record<string, string> = {}): void {
  if (!testDatabaseUrl) return;
  process.env.DATABASE_URL = testDatabaseUrl;
  Object.assign(process.env, extraEnv);
}
