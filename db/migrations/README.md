# Database migrations

SQL migrations applied by [`src/lib/migrate.ts`](../../src/lib/migrate.ts)
(`npm run migrate`). Each file is applied once, inside a transaction, and
recorded **by filename** in the `schema_migrations` table; already-recorded
files are skipped on the next run. Files are applied in **lexicographic order**,
which — because every name starts with a zero-padded number — is also numeric
order.

## Naming convention

```
NNNN_short_snake_case_description.sql
```

- **`NNNN`** — a 4-digit, zero-padded sequence number. It must be **unique** and
  strictly increasing. Pick the next number by taking the highest existing one
  and adding 1 (e.g. after `0011_…` the next is `0012_…`).
- **`short_snake_case_description`** — a few words describing the change
  (`gps_coords`, `soft_delete`, `root_export_kind`). Keep it lowercase with
  underscores; it shows up in `schema_migrations` and in `migrate` logs.

One logical change per file. Smaller, focused migrations are easier to review
and to reason about when something fails.

## Rules

1. **Unique, sequential numbers — no duplicates.** Two files with the same
   number "work" today only because the rest of the filename breaks the tie
   lexicographically, but that ordering is accidental and brittle. Always use a
   fresh number. If two branches both grab the same next number, the one that
   merges second must renumber its file *before* it is applied anywhere.

2. **Append-only / immutable once applied.** A migration that has run against any
   real database (CI, a dev box, the server) is frozen: do **not** edit its SQL
   and do **not** renumber or rename it. The runner tracks files by name, so a
   rename makes an already-applied file look new and it gets re-run; an edit is
   simply never re-applied. To change something, add a *new* migration.

3. **Write idempotent SQL.** Use `CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
   `DROP … IF EXISTS`, `CREATE OR REPLACE FUNCTION`, etc. Each file runs in a
   single transaction and is rolled back on error, so a half-applied migration
   can be safely retried.

## History

Two rounds of collisions from parallel work were renumbered into the strict
sequence above:

**2026-06** — `0006_` and `0007_` once had two files each:

| Old name                       | New name                       |
| ------------------------------ | ------------------------------ |
| `0006_session_completed.sql`   | `0007_session_completed.sql`   |
| `0007_duplicate_hits.sql`      | `0008_duplicate_hits.sql`      |
| `0007_soft_delete.sql`         | `0009_soft_delete.sql`         |
| `0008_gps_coords.sql`          | `0010_gps_coords.sql`          |
| `0009_root_export_kind.sql`    | `0011_root_export_kind.sql`    |

**2026-07** — `0016_bursts.sql` (PR #104) collided with `0016_session_lifecycle.sql`
merged in parallel. Per rule 1, the burst migration (merged second) is renumbered
to the tail of the sequence:

| Old name             | New name             |
| -------------------- | -------------------- |
| `0016_bursts.sql`    | `0029_bursts.sql`    |

Moving the burst backfill later in the order is safe: no migration in `0017`–`0028`
references the `bursts` table or `assets.burst_id`, and the backfill is a no-op on
a fresh database (no assets exist yet at migrate time).

Because migrations are tracked by filename, databases migrated *before* a
renumbering recorded the old names. `migrate.ts` carries a one-time
`reconcileRenumbered` shim that rewrites those `schema_migrations` rows to the
new names, so the renamed files are recognised as already applied instead of
being re-run. It is a no-op on a fresh database. This is the one sanctioned
exception to rule 2 — and the reason the rule exists.
