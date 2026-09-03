# Database & migrations

Read before touching `db/migrations/`, the schema, indexes, `src/lib/db.ts`, or anything SQL.

Seeded 2026-08-20 from `db/migrations/README.md`, `src/lib/migrate.ts`, `docs/ARCHITECTURE-REVIEW.md` §3.2 and the migration files themselves. `db/migrations/README.md` is the full convention with its history — read it before adding a migration; this file keeps the parts that cost time.

## Postgres is the only copy of the curation state (2026-08-20)

**Decision**: verdicts, stars, tags, people, lineage — everything the culling work produces — lives **only** in Postgres. The RAWs on the NAS are read-only and never lost; the curation is not backed by anything else, hence the `backup` sidecar (`BACKUP_INTERVAL`, `BACKUP_KEEP_DAYS`) and `docs/BACKUP.md`.

**How to apply**: a migration that drops or rewrites curation data is destroying the irreplaceable half of this system. Prefer additive migrations; when data must move, move it, do not recompute it from the files.

## Migration numbers must be unique — a rename costs a shim (2026-08-20)

**Decision**: `NNNN_snake_case.sql`, unique and strictly increasing, applied in lexicographic (= numeric) order, tracked **by filename** in `schema_migrations`, each file in one transaction, SQL written idempotently (`IF NOT EXISTS`, `CREATE OR REPLACE`). Append-only: a file that ran anywhere is frozen — no edits, no renames. If two branches grab the same number, the one that merges **second** renumbers, to the tail of the sequence.

**Why**: tracking by filename is what makes the runner simple, and it is exactly why a rename is expensive — a renamed file looks new and re-runs on every database that already applied it. `src/lib/migrate.ts` therefore carries `RENUMBERED`, a one-time table of old→new names that rewrites `schema_migrations` rows; it is a no-op on a fresh database. Three rounds of collisions have already gone through this (2026-06, 2026-07 ×2).

**How to apply**: take the highest number present and add one — do not trust the last number you remember. If you must renumber, add the pair to `RENUMBERED` in the same commit and justify in `db/migrations/README.md` that nothing between the old and new positions depends on the moved migration. The one sanctioned exception to append-only is documented there: a migration that *failed* everywhere never recorded itself, so editing it in place is the only fix that reaches those databases.

**Live trap**: two duplicate prefixes are still on `main` despite the README claiming the sequence is strict — `0010_gps_coords` / `0010_search_text` and `0013_asset_groups` / `0013_clean_object_placeholders`. They apply in an accidental lexicographic order. Tracked as an open item in `MEMORY.md`; do not "tidy" them without the maintainer, since it touches every migrated database.

## CI migrates against pgvector, deliberately (2026-08-20)

**Decision**: the CI `build` job runs `pgvector/pgvector:pg16`, not plain `postgres:16`.

**Why**: `0030_clip_embeddings.sql` now *skips* its table when the `vector` extension is missing instead of failing. On a plain image CI would migrate green and silently never exercise the `asset_clip` DDL. The pgvector image is what makes CI cover the branch that actually creates the table.

**How to apply**: keep the image. If you add a migration guarded on an extension, make sure CI runs on an image that has it, or the guard is untested.

## Indexing and query-shape rules learned the hard way (2026-08-20)

**Decision**: every dynamic SQL site builds `$n` placeholders, filters are validated by Zod, LIKE is escaped and facet column names are hardcoded. `src/lib/db.ts` exposes a `tx()` helper; `DB_POOL_MAX` sizes the pool per process and `application_name` is set for `pg_stat` attribution.

**Why**: string-built SQL is how injection gets in, and the pool is per-process — app and worker each open their own, so the server sees up to 2×. Keep the sum of worker concurrencies ≤ `DB_POOL_MAX`: each active job may hold a connection.

**How to apply**: never interpolate a value into SQL. Use `tx()` for any multi-statement write that must not half-apply — review R7 lists the ones that still do not (`pairing.ts` group creation, `bursts.ts restackSession`, session hard-delete). A page-load query must be scoped: `/api/sessions` used to aggregate the whole live library on every load and was rewritten to `LEFT JOIN LATERAL` per session (D1) — that class of unscoped `GROUP BY` is the identified scaling cliff.

**Note**: the `int8 → Number` type parser silently loses precision past 2^53. Unreachable at current scale and unguarded (D10).

## Growth with no retention is the known unpaid debt (2026-08-20)

**Decision (pending)**: `purge_log`, resolved `scan_failures`, `export_jobs.result` / `import_batches.result` JSONB, `exports` lineage and stale-model `asset_clip` rows all grow without bound. A retention janitor is P1 in the review (D7) and does not exist yet.

**How to apply**: if you add a table that accumulates a row per event, say in the migration how it gets pruned — or add it to the janitor list in `MEMORY.md`'s open items rather than leaving it silent.

## Timeline chapters are corrections, not entities (2026-09-03)

**Decision**: migration `0040_timeline_chapters.sql` adds two small tables that store what a human changed about the Timeline's *derived* chapters, never the chapters themselves: `timeline_chapters` (a named span `[starts_at, ends_at]` + optional `name`, `place_label`, `place_lat/lon`) and `timeline_breaks` (a forced split `at`). `lib/timeline.ts` folds them back in: every break and both edges of every span become forced breaks in the SQL scan (the end edge is `ends_at + 1 s`, or the span's last frame would be cut off its own span), runs inside a span are pinned into one group that neither absorbs nor gets absorbed, and the span's name/location replace the derived ones. Spans may not overlap (the POST refuses); span bounds are immutable (reset and redraw, so a span's identity is its range).

**Why**: a chapter is a function of capture time + place; storing it would let the first photo re-indexed inside a period contradict the stored cut, and every rescan would have to reconcile two truths. Storing the edit keeps re-derivation safe — the exact reasoning `0029_bursts.sql` gives for keeping ratings per asset.

**Retention**: both tables grow only by a human clicking Rename / Split / Merge and shrink from the same dialog — tens of rows, no automatic writer, hence no janitor (the migration says so, per the rule above).

**How to apply**: a new kind of chapter edit is a new correction folded in by `lib/timeline.ts`, not a new column on a stored chapter. A span's location is the *chapter's*: nothing in these tables or their routes writes GPS onto assets (`docs/memory/architecture.md`, "A deduced location never writes into an original").
