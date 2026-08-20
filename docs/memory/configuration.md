# Configuration & environment

Read before adding or changing an environment variable, or touching `src/lib/config.ts`, `.env.dist` or the compose env anchors.

Seeded 2026-08-20 from `src/lib/config.ts`, `.env.dist`, `CONTRIBUTING.md` and `docs/ARCHITECTURE-REVIEW.md` §3.5.

## One Zod schema, parsed once, fail-fast at boot (2026-08-20)

**Decision**: the entire environment is parsed once through a Zod schema in `src/lib/config.ts`, which aggregates every problem and crashes the process at startup with a precise message. A blank value falls back to its default; a value that is *present but invalid* (typo'd `STORAGE_DRIVER`, non-numeric concurrency, `s3` selected without credentials) is a hard error, never a silent degradation.

**Why**: this runs unattended on a home server. A misconfiguration that degrades silently is discovered weeks later through missing derivatives; a boot crash is discovered immediately.

**How to apply**: never read `process.env` outside `config.ts` — a variable read elsewhere bypasses validation and is a bug. New knobs get a default and, for numbers, bounds. The helpers (`strEnv`, `intEnv`, …) exist so "present but invalid" cannot become "reverted to default".

## A new variable lands in three places, four in production (2026-08-20)

**Decision**: adding a variable means (1) the `envSchema` in `src/lib/config.ts`, (2) the exported `config` object beside it, (3) `.env.dist` with a comment explaining it — `CONTRIBUTING.md` states this — and, to be tunable in production, (4) the `x-winnow-env` anchor in `docker-compose-optiplex.yml`.

**Why**: `.env.dist` is the only documentation of the configuration surface, and `make init` copies it to `.env`. Step 4 is the one that gets forgotten: the review (§3.5) found the Optiplex anchor already missing `ML_CLIP_*`, `IMMICH_*`, `BURST_*`, `SHARP_CONCURRENCY`, `PURGE_*`, `HEIC_DECODE_TIMEOUT_MS`, `BROWSE_ROOTS` and `FINALS_DIRS` — defaults keep production working, so nothing breaks; production simply cannot tune those. Generating both env blocks from one source, or moving to `env_file`, is the proposed fix (P1) and has not been done.

**How to apply**: do all four, and check the drift list above before assuming a variable is settable on the Optiplex.

## `config.ts` is server-only (2026-08-20)

**Decision**: `src/lib/config.ts` holds the S3 credentials and must never reach the client bundle. Only `NEXT_PUBLIC_*` variables may be read from a client component (`CONTRIBUTING.md`).

**How to apply**: if a client component needs a value, pass it down from a server component or expose it as `NEXT_PUBLIC_*` — importing `config` into a `"use client"` file is the mistake to catch in review.

## Some settings live in the database, not the environment (2026-08-20)

**Decision**: rates (`scanPerHour`, `analyzePerHour`, `mlPerHour`, `geocodePerHour`, `rescanMinutes`) and the pause flag live in `app_settings` and are tunable live from the UI. Concurrency knobs are environment/boot-time.

**Why**: pacing has to change while the pipeline is running (thermals, an overnight backfill); pool and concurrency sizing does not, and changing it needs a restart anyway.

**How to apply**: a knob that a human will want to turn *while watching the pipeline* belongs in `app_settings`; a knob that shapes process startup belongs in the environment. Known bug to avoid inheriting: `getSettings()` falls back to defaults on any DB error, so a Postgres blip silently un-pauses the pipeline and lifts every rate limit — it should fail closed on the last-known values (review C8).

## The dev defaults in `.env.dist` are dev defaults (2026-08-20)

**Decision**: `.env.dist` ships `winnow:winnow` for Postgres and `minioadmin:minioadmin` for MinIO, with an inline SECURITY note telling you to change them; compose binds the Postgres/Redis host ports to `127.0.0.1`.

**How to apply**: they are safe to keep in git *because* they are documented placeholders bound to loopback — do not treat them as a leak to fix, and do not copy them into anything reachable from the LAN. The real values are set in the maintainer's `.env` on the Optiplex, which is gitignored and has never been committed.
