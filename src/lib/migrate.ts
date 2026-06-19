// Applies the SQL migrations from db/migrations in lexicographic order.
// Idempotent: each applied file is recorded in schema_migrations.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./db";

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
        console.log(`= ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`▶ applying ${file}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`✔ ${file}`);
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
      console.log("Migrations complete.");
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migrations failed:", err);
      process.exit(1);
    });
}
