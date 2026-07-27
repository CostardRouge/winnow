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

Three rounds of collisions from parallel work were renumbered into the strict
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

**2026-07 (second pass)** — the two duplicate prefixes still left on `main` after
the bursts fix. In both cases the file listed below is the one that merged
*second* under that number, so per rule 1 it is the one that moves, again to the
tail of the sequence:

| Old name                       | New name                       | Collided with                  |
| ------------------------------ | ------------------------------ | ------------------------------ |
| `0025_clip_embeddings.sql`     | `0030_clip_embeddings.sql`     | `0025_missing_files.sql`       |
| `0026_manual_geotag.sql`       | `0031_manual_geotag.sql`       | `0026_dedup_self_hits.sql`     |

Both moves are safe: nothing between the old and new positions references
`asset_clip`/the `vector` type (`0021_ml_faces` stores face embeddings as JSONB
and only mentions pgvector in comments) or the `assets.gps_source` /
`gps_write_status` / `gps_write_error` columns the geotag migration adds.

Renumbering CLIP also shrinks a real blast radius. Under `0025_`, the
lexicographic tie-break put `clip_embeddings` *before* `missing_files`, so the
`CREATE EXTENSION vector` it used to open with aborted the whole run at the
earliest possible point — `0025`–`0029` never applied on a Postgres without
pgvector. It is now both last in the order and non-fatal (it skips the table with
a `NOTICE` instead of failing), so a missing extension costs only the feature.

That non-fatal rewrite edited an already-applied migration, which rule 2 forbids.
It is allowed here for the same reason the renumbering is: a database that
*failed* on the file never recorded it (the transaction rolled back), so a new
migration appended at the tail would never be reached — `migrate` still aborts at
the old file first. Editing in place is the only fix that reaches those
databases, and it is inert everywhere else: where the original succeeded, the
shim below marks the file applied and the new text is never executed.

Because migrations are tracked by filename, databases migrated *before* a
renumbering recorded the old names. `migrate.ts` carries a one-time
`reconcileRenumbered` shim that rewrites those `schema_migrations` rows to the
new names, so the renamed files are recognised as already applied instead of
being re-run. It is a no-op on a fresh database. This is the one sanctioned
exception to rule 2 — and the reason the rule exists.
