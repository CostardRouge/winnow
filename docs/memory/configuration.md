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

## Some settings live in the database, not the environment (2026-08-20, revised 2026-09-14)

**Decision**: the nine `AppSettings` keys (pause, `scanPerHour`, `analyzePerHour`, `mlPerHour`, `geocodePerHour`, `geocodePrecisionM`, `rescanMinutes`, `exportIncludeJpeg`, `exportIncludeLiveVideo`) live in `app_settings`. Concurrency knobs are environment/boot-time.

**Why**: pacing has to change while the pipeline is running (thermals, an overnight backfill); pool and concurrency sizing does not, and changing it needs a restart anyway.

**Adding a key to `AppSettings` is not done until something writes it.** Three of the nine (`geocodePerHour`, `geocodePrecisionM`, `exportIncludeLiveVideo`) shipped with a default, a worker reading them and a `PATCH /api/settings` that accepted them — and no control anywhere, for months, reachable only by `curl`. `exportIncludeLiveVideo` is the instructive one: `ExportFilePicker` *read* it as a default, which makes the key look wired up from the export side while nothing could ever change it. All nine have a writer now (seven on Settings › Pipeline, the two export companions in the Exports toolbar), so the check to run before calling a new key shipped is `grep -rn "<key>" src/app` — a reader is not a writer.

**Geocoding's two knobs carry a consequence the UI has to state**: `precision_m` is part of the `places` primary key (`cell_lat, cell_lon, precision_m`), so changing the cell size re-tags nothing already geocoded — it starts a fresh set of cells, every one of which misses the cache and costs a real Nominatim call. Bigger cells mean fewer calls and coarser names; the rate is what bounds the burst. Their control group is gated on `geocodeEnabled` from `/api/stats`, mirroring `mlEnabled`: with `GEOCODE_ENABLED=false` the worker deliberately leaves assets `pending`, so a rate and a cell size would be knobs on a stage that cannot run.

**The rule answers the wrong question, and it shows.** "Does it need a restart" is a fact about the runtime; the useful question is *whose decision is it* — the operator's (paths, credentials, concurrency), the photographer's (what counts as a burst, who appears on People, how coarse a place name is) or the moment's (pause, rates). Knobs of identical nature sit on opposite sides today: `geocodePrecisionM` is live while `ML_PERSON_MIN_FACES`, `ML_PERSON_MIN_SIMILARITY`, `BURST_GAP_SECONDS` and `BURST_MIN_FRAMES` — all re-derivable, all changing only what you *see* — need a container restart. Moving those four into `app_settings` is the fix of record; `docs/SETTINGS-UI.md` §3 (D15, D16) carries the argument.

**How to apply**: a knob that a human will want to turn *while watching the pipeline* belongs in `app_settings`; a knob that shapes process startup belongs in the environment; a knob that changes what a page shows and is cheap to re-derive belongs in `app_settings` too, whatever the restart rule says. Adding a key to `AppSettings` is not done until something writes it — check `grep -rn "<key>" src/app` before calling it shipped. Known bug to avoid inheriting: `getSettings()` falls back to defaults on any DB error, so a Postgres blip silently un-pauses the pipeline and lifts every rate limit — it should fail closed on the last-known values (review C8).

## `localStorage` is a fourth settings tier nobody designed (2026-09-14)

**Observation**: sixteen `winnow.*` keys hold real preferences — `theme`, `grid.size`, `sessions.layout`, `gallery.aside`, `pipeline.{view,sort,density}`, `gear.{view,source}`, `viewer.info`, `dedup.scope`, `relink.job` and five separate remembered library sources. They accumulated one page at a time, and unlike the other three tiers none of them is visible from Settings, resettable, or carried to a second device. `db/migrations/0032_users.sql` creates a `users` table with no preferences beside it, so there is no account-level home for the ones that want one (theme above all: desktop and phone disagree permanently).

**How to apply**: a new remembered view preference joins this tier by default and that is usually right — but say so deliberately rather than by reflex, and use the `winnow.<area>.<thing>` naming already in the tree. If a preference should follow the *person* rather than the browser, it needs a `user_preferences` row, which does not exist yet: proposing one is a decision, not a chore. Counting the tier: 68 env vars + 9 `app_settings` + 6 feature flags + 16 device keys = 99 knobs, 13 of them managed from a Settings page (`docs/SETTINGS-UI.md` §3).

## The dev defaults in `.env.dist` are dev defaults (2026-08-20)

**Decision**: `.env.dist` ships `winnow:winnow` for Postgres and `minioadmin:minioadmin` for MinIO, with an inline SECURITY note telling you to change them; compose binds the Postgres/Redis host ports to `127.0.0.1`.

**How to apply**: they are safe to keep in git *because* they are documented placeholders bound to loopback — do not treat them as a leak to fix, and do not copy them into anything reachable from the LAN. The real values are set in the maintainer's `.env` on the Optiplex, which is gitignored and has never been committed.

## Feature flags are a third kind of setting, with their own row (2026-09-07)

**Decision**: which optional *sections* of the app this instance offers (Timeline, Sift, Search, People, Gear — the Library has no flag) is stored in `app_settings` under a single `features` jsonb row, read by `src/lib/featureGate.ts` and edited on `/settings/features`. It is deliberately NOT an env var and deliberately NOT part of `AppSettings`.

**Why**: `NEXT_PUBLIC_*` is inlined at `next build` and the image is built in CI, so an env flag set in `docker-compose-optiplex.yml` would never reach the browser bundle — it would fail silently, the worst behaviour for a switch whose job is to be visible (`src/app/mapTiles.ts` already records the trap). And `AppSettings` is the contract shared with the *workers*; no worker cares whether the Gear shelf is on screen, so widening it would put a UI concern in every worker's hot path.

**How to apply**: adding a section means one entry in the `FEATURES` registry (`src/lib/features.ts`), one rail entry carrying its `feature` id, `requireFeature()` in its page(s) and `featureOff()` in the API routes it owns. No migration: the row is key/value jsonb and `parseFeatures()` fills missing ids from the registry's defaults. The registry file is imported by a client component, so it must stay free of `./db` — the server half lives in `featureGate.ts`, and merging the two put `pg` in the browser bundle and broke the build. `getFeatures()` fails **open** (defaults) on a DB error, unlike `getSettings()`'s known bug: a flag hides a section, it never guards data.
