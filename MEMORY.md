# Project memory — decisions, reasons, traps

Long-term memory of this repo, read at the start of **every** agent session (imported by `CLAUDE.md`). It holds what the code and `git log` cannot tell you: the choices made and their reasons, what was tried and rejected, the traps that cost time, how the maintainer likes to work.

This file is the **always-loaded index**. The detail lives in `docs/memory/<topic>.md`, one file per area, loaded **on demand**: read the topic file(s) matching the area you are about to touch **before** acting (table at the bottom). Do not `@import` them into `CLAUDE.md` — the split exists to keep the per-session prompt small.

## How to maintain (mandatory — CLAUDE.md rule 2)

- **When**: at the end of every task, before its commit, in the same commit. Writing is the **default**; only skip if there is truly nothing a future agent could use, and say so explicitly in the final message.
- **What**: a design/product decision, a non-obvious technical choice, an explicit rejection ("the maintainer did not want X because Y"), a trap (browser, tooling, framework, hosting) and its remedy, a working preference. Not implementation detail readable in the diff, not what `git log` already says, not history ("this was fixed on…") — once a fix is committed, keep only the rule it taught.
- **Where**: the matching `docs/memory/<topic>.md`; a new file only when no topic fits (kebab-case name, add it to the table below with a "read when"). Cross-cutting rules, working style, decisions-at-a-glance and open items stay in this index.
- **How**: search first and **update** the existing entry rather than adding a near-duplicate; delete what became false. One entry = one short paragraph: *decision → why → how to apply*, dated `YYYY-MM-DD` on first write and on each revision. Say the same thing **once** — cross-reference other files by name instead of repeating.
- **Language**: **English**, dense, factual. No session narration.
- Budget: keep this index under ~200 lines and each topic file under ~150; if one outgrows that, split it.

## Working with Steeve Pommier

<!-- Fill in as you learn: how they validate work, how they phrase requests,
     what they want when an audit finds problems, what annoys them. -->

- 2026-08-20 — Roughly half this history is authored by Claude and merged through numbered PRs (`#212`…`#225`), the other half by the maintainer directly. Agent work arrives as a branch + PR whose title reads like the rest of the log — not as commits pushed to `main`.
- 2026-08-20 — Documentation is a deliverable here, not an afterthought: a 1000-line `README.md`, a `CONTRIBUTING.md` that names the CI gate, a `db/migrations/README.md` that argues its own rules and records every past collision, and an `ARCHITECTURE-REVIEW.md` that grades the codebase and names its own weaknesses. Match that register — explain the *why* and the trade-off, and say plainly what is fragile.
- 2026-08-20 — The code comments carry the reasoning, including the uncomfortable kind ("this API is unversioned", "this is the one sanctioned exception to rule 2"). A diff that deletes a *why* comment reads as a regression.
- 2026-08-20 — When an audit finds problems, the established form is the one `ARCHITECTURE-REVIEW.md` uses: numbered findings, an explicit status (**Fixed** / roadmap tier), and the fixes shipped alongside the report. Findings without that structure will feel unfinished.

## Direction in five lines

- Winnow is one photographer's ingest → cull → export pipeline over a home NAS, not a product: it targets the maintainer's real library (Sony A7C II / DJI / iPhone / Ray-Ban Meta) on a single Optiplex box.
- The guiding principle, stated in `README.md` and enforced throughout: **the originals are touched once**. Everything afterwards reads Postgres and the derivative cache; deletes are soft.
- Culling happens on lightweight proxies, never on RAWs. Immich keeps the browsing/phone job; Winnow pushes copies to it rather than absorbing it.
- Scope grows by the verbs the workflow needs (sift, bursts, faces, places, gear, people) — each lands as a page + an API route + usually a migration.
- Scale target, per `docs/ARCHITECTURE-REVIEW.md`: comfortable at ~100k assets, with the sharding/ANN/retention decisions deliberately deferred to 500k–1M.

## Decisions at a glance (details in the topic files)

- Originals are read-only and read once; deletes are soft → `docs/memory/architecture.md`
- Derivatives sit on disk behind an S3-shaped driver, so MinIO is one env flip away → `docs/memory/architecture.md`
- Dedup is a partial hash arbitrated by a full-content compare, every decision logged → `docs/memory/architecture.md`
- Only Incoming copies are ever deletable, so "no RAW in the Gallery" is reported, not fixed, by dedup → `docs/memory/architecture.md`
- Removing an asset's bytes must release its `content_hash`, or the surviving file is unindexable forever → `docs/memory/architecture.md`
- Logic lives in `src/lib/`; worker, API routes and CLI scripts are thin wrappers → `docs/memory/architecture.md`
- One worker process, nine BullMQ queues, chained manually rather than by BullMQ flows → `docs/memory/pipeline.md`
- Worker memory hygiene (jemalloc, out-of-process HEIF decode, `sharp.cache(false)`) is load-bearing → `docs/memory/pipeline.md`
- ML is a remote HTTP call to Immich's internal `/predict`; Winnow embeds no model → `docs/memory/pipeline.md`
- Migrations are append-only and uniquely numbered; a rename costs a `RENUMBERED` shim → `docs/memory/database.md`
- All configuration passes one Zod schema that fail-fasts at boot → `docs/memory/configuration.md`
- Rates live in the database (tunable live), concurrency in the environment (needs a restart) → `docs/memory/configuration.md`
- Deploy is push-to-`main` → ghcr image → Watchtower pull on the Optiplex, behind Traefik + Cloudflare Tunnel → `docs/memory/deployment.md`
- Identity lives in the app (`src/proxy.ts` + `src/lib/authz.ts`), not in the reverse proxy → `docs/memory/auth.md`
- Atelier (the editing app, a sibling subdomain) calls the API cross-origin with the session cookie: same-site, so no token — just an exact-origin CORS allowlist answered before the session check, plus `GET /api/capabilities` → `docs/memory/auth.md`
- Styling is a token-based "Paper" system of semantic classes in `globals.css`, not utilities in JSX → `docs/memory/frontend.md`
- Every DB-backed route opts out of static rendering with `force-dynamic` → `docs/memory/frontend.md`
- The dedup triage page pages server-side on its own endpoint, off the shared failures poll → `docs/memory/frontend.md`
- The whole verification gate is `typecheck` + `migrate` + `build`; no linter, no tests → `docs/memory/testing-and-ci.md`

## Open items (dated; remove when done)

- 2026-08-20 — **Two duplicate migration prefixes are still on `main`**, contradicting rule 1 of `db/migrations/README.md` and its "History" section, which reads as though every collision was resolved: `0010_gps_coords.sql` / `0010_search_text.sql` and `0013_asset_groups.sql` / `0013_clean_object_placeholders.sql`. They apply today in an accidental lexicographic order. Renumbering means extending `RENUMBERED` in `src/lib/migrate.ts` and touches every already-migrated database — maintainer's call. Next free number is `0039`.
- 2026-08-20 — The P1 list in `docs/ARCHITECTURE-REVIEW.md` §4 is the standing backlog (disk-space preflight, streamed video proxies, retention janitor, the `asset_faces.embedding` decision, job cancel, fail-closed `getSettings()`, compose env drift). Check it before proposing pipeline work; nothing in this memory supersedes it.
- 2026-09-02 — **The purge worker still leaves `content_hash` set on the rows it purges** (`src/lib/purge.ts` step 3), while `reclaimTrashedAsset` in `src/lib/duplicates.ts` releases it and documents why a purged row holding a hash makes the surviving file unindexable forever. The dedup sweep now repairs those rows after the fact ("Clear resolved"), so nothing is stuck — but the two paths disagree, and fixing the worker would stop the state from being created at all. It changes purge semantics for every already-purged row, so it is the maintainer's call.
- 2026-08-20 — No test suite and no test runner. Several pure functions are explicitly shaped for testing (review §3.5) but nothing runs them, so every refactor rides on `tsc` alone. Adding the first test also means choosing a runner and adding a CI job — a decision, not a chore.
- 2026-08-20 — `docker-compose-optiplex.yml`'s `x-winnow-env` anchor is missing a documented set of variables (`ML_CLIP_*`, `IMMICH_*`, `BURST_*`, `SHARP_CONCURRENCY`, `PURGE_*`, `HEIC_DECODE_TIMEOUT_MS`, `BROWSE_ROOTS`, `FINALS_DIRS`). Defaults keep production running, so it fails silently: those knobs simply cannot be tuned on the Optiplex. See `docs/memory/configuration.md`.

## Topic files — read before touching the area

| File | Read when you touch… |
| --- | --- |
| `docs/memory/architecture.md` | the overall shape: originals policy, storage driver, dedup, the app/worker split |
| `docs/memory/pipeline.md` | the worker, any queue, scanning, derivatives, ML, geocoding, rate limits, memory behaviour |
| `docs/memory/database.md` | `db/migrations/`, the schema, indexes, `src/lib/db.ts`, anything SQL |
| `docs/memory/configuration.md` | env vars, `src/lib/config.ts`, `.env.dist`, the compose env anchors, live settings |
| `docs/memory/deployment.md` | the `Dockerfile`, compose files, CI workflows, the Optiplex / Traefik / Cloudflare path |
| `docs/memory/frontend.md` | `src/app/**`, pages, styling, the viewer/grid interactions, the PWA |
| `docs/memory/auth.md` | login, invites, sessions, roles, `src/proxy.ts`, `src/lib/{auth,authz}.ts` |
| `docs/memory/testing-and-ci.md` | deciding a change is done, `.github/workflows/`, adding tests |
