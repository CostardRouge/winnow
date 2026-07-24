// Applies the SQL migrations from db/migrations in lexicographic order, which
// (thanks to the zero-padded NNNN_ prefix) is also numeric order. Idempotent:
// each applied file is recorded by filename in schema_migrations and skipped on
// the next run. Naming/ordering convention: db/migrations/README.md.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool } from "./db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations");

// One-time shims for the renumberings that removed duplicate NNNN_ prefixes
// (see db/migrations/README.md "History"). Migrations are tracked by filename, so
// a database migrated before a renumbering recorded the OLD name and would
// otherwise re-run the renamed file. Rewrite those rows to the new names so the
// renumbered files are recognised as already applied. No new name equals any old
// name, so the rewrites are independent; on a fresh database nothing matches and
// this is a no-op.
//
//   * 2026-06 — the original 0006_/0007_ collision from parallel work.
//   * 2026-07 — `0016_bursts.sql` (PR #104) collided with `0016_session_lifecycle`
//     merged in parallel. Bursts is renumbered to the tail (0029); moving its
//     backfill later is safe (no 0017–0028 migration references the bursts table).
const RENUMBERED: ReadonlyArray<readonly [oldName: string, newName: string]> = [
  ["0006_session_completed.sql", "0007_session_completed.sql"],
  ["0007_duplicate_hits.sql", "0008_duplicate_hits.sql"],
  ["0007_soft_delete.sql", "0009_soft_delete.sql"],
  ["0008_gps_coords.sql", "0010_gps_coords.sql"],
  ["0009_root_export_kind.sql", "0011_root_export_kind.sql"],
  ["0016_bursts.sql", "0029_bursts.sql"],
];

async function reconcileRenumbered(client: PoolClient): Promise<void> {
  for (const [oldName, newName] of RENUMBERED) {
    // Defensive: if both rows somehow exist, drop the stale one before renaming
    // to avoid a primary-key conflict on the UPDATE below.
    await client.query(
      `DELETE FROM schema_migrations
         WHERE name = $1
           AND EXISTS (SELECT 1 FROM schema_migrations WHERE name = $2)`,
      [oldName, newName],
    );
    await client.query(
      "UPDATE schema_migrations SET name = $2 WHERE name = $1",
      [oldName, newName],
    );
  }
}

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await reconcileRenumbered(client);

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
