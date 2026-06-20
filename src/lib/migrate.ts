// Applies the SQL migrations from db/migrations in lexicographic order.
// Idempotent: each applied file is recorded in schema_migrations.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./db";
import { createLogger } from "./log";

const log = createLogger("migrate");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations");

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const done = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [file],
      );
      if (done.rowCount) {
        log.debug("already applied", { file });
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      log.info("applying migration", { file });
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        log.info("migration applied", { file });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// Direct execution: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      log.info("migrations complete");
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      log.error("migrations failed", { err });
      process.exit(1);
    });
}
