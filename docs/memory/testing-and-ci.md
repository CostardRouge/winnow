# Verification, CI, and what green does not prove

Read before deciding a change is "done", or before touching `.github/workflows/`.

Seeded 2026-08-20 from `.github/workflows/ci.yml`, `CONTRIBUTING.md`, `package.json` and `docs/ARCHITECTURE-REVIEW.md` §3.5.

## The gate is three commands, and that is the whole gate (2026-08-20)

**Decision**: `npm run typecheck` (`tsc --noEmit`), `npm run migrate` (against a real Postgres — the SQL is part of the contract), `npm run build`. CI runs exactly these: a fast `typecheck` job with no services, and a `build` job with a `pgvector/pgvector:pg16` service.

**How to apply**: run them locally before committing; a red one is a broken PR, and CI cancels superseded PR runs but never cancels a run on `main`. `paths-ignore` skips CI entirely for `**/*.md`, `docs/**` and `LICENSE` — a docs-only change gets no CI run at all, which is fine but means "CI passed" is not a statement about it.

## No linter; a young test suite that CI does not run yet (2026-08-20, revised 2026-10-02)

**Fact**: no ESLint config exists — `tsc --noEmit` is the static gate. Since 2026-10-02, `npm test` runs `tsx --test "src/**/*.test.ts"`: Node's built-in `node:test` + `node:assert/strict`, through the `tsx` that is already a runtime dependency — **no test package was added**, which is why it was chosen over vitest/jest. Tests sit next to the module they test (`src/lib/authz.test.ts`).

**DB-backed tests are opt-in**: they run only when `WINNOW_TEST_DATABASE_URL` is set, and point `DATABASE_URL` at it before importing anything — never at whatever database the shell happens to have, because a test that inserts rows must not be able to land them in a real library. Without it they **skip and say so**. Locally: a migrated scratch database (`npm run migrate` against it first).

**Consequences to hold in mind**: coverage is thin (the role policy and the batch-1 regression tests), so most refactors still have only the type checker behind them. "It builds" means it compiles; for anything user-visible, look at it in the browser. CI does not run `npm test` until decision D8 (`docs/CODEBASE-AUDIT.md`) is taken.

**How to apply**: a bug fix ships with a test that fails without it. Good next seams, pure and mock-free: `categorizeAsset`, `includeFromParams`, `snapToCell`, `lineageRole`, burst clustering, filter building, the pure half of `lib/timeline.ts`.

## The CI environment is a deliberate mirror of production (2026-08-20)

**Decision**: Node 24 in CI matches the `node:24-slim` runtime image (both moved from 22 on 2026-10-09; `engines` keeps the floor at 22, and `@types/node` is `^24` to match); the Postgres service is pgvector-on-16 to match both the compose image major and the extension the CLIP migration needs.

**Why**: CI is meant to validate what ships. Drifting the Node major or the Postgres major would make a green build meaningless for the box it deploys to.

**How to apply**: if you bump one, bump the others in the same commit — `Dockerfile` (`node:24-slim`, `postgresql-client-16`), the compose `postgres` image, and both CI jobs. See `docs/memory/deployment.md` for why the Postgres client major must track the server major.

## Measuring without the Optiplex, and a file search skips (2026-10-02)

**How**: a container with Postgres 16 + Redis is enough to run `next start` and measure for real — seed a synthetic library (`generate_series` into `roots`/`sessions`/`assets`/`ratings`; the CHECK lists are in the migrations) and time routes with `curl -w %{time_total}`, `EXPLAIN (ANALYZE, BUFFERS)` the SQL `buildFilter` emits, and drive the UI with Playwright's Chromium. `docs/CODEBASE-AUDIT.md` §1 lists what that setup cannot see (production `pg_stat_*`, NAS latency, Traefik/Watchtower config) — state those limits next to any number.

**Trap**: `src/lib/lensLabels.ts` contains literal NUL bytes (lines 116, 127), so git shows it as binary, `grep` says "binary file matches" and ripgrep **skips it silently**. Search with `grep -a` / `rg -a` until DX-03 escapes them.


## `next dev` edits two tracked files: never commit them (2026-10-09)

**Trap**: running `next dev` (16.x) appends a `nextjs-agent-rules` block to `CLAUDE.md` and rewrites `next-env.d.ts` to `./.next/dev/types/…`. Both are tooling noise: leave them unstaged and `git checkout --` them once the dev server is stopped (it re-adds them while running). The block's own text says committing it "keeps the tree clean" — that is the generator talking, not a project rule. A browser check of a page needs Postgres 16 **with pgvector** (`apt-get install postgresql-16-pgvector`; four migrations need it), a Redis, and a session cookie minted with `createSession()` from `lib/auth.ts`.

## The indexer is testable without Redis: index into an ignored session (2026-10-09)

**Fact**: `indexRoot` touches Redis only to enqueue (derivatives, geocode), and
`lib/queue.ts` builds its ioredis client with `lazyConnect` — so a test that
pre-creates the folder's session with `ignored = true` indexes real files, runs
the real UPDATE and the end-of-scan reconciliations, and never opens a socket.
`src/lib/deviceAttribution.test.ts` does exactly that over a real JPEG whose
EXIF it writes with `exiftool-vendored`, then bumps the mtime and re-indexes.

**How to apply**: a change to the indexer's write (a guard, a provenance, a
column it must keep) gets a test in that shape, not a hand-copied SQL fragment —
a copy proves nothing about the statement that ships. Check that it FAILS with
the change removed: for the camera-body guard it did. Keep `GEOCODE_ENABLED=false`
and fixtures without GPS, or the geocode enqueue reaches for Redis after all.

- 2026-10-10 — **Test files run in parallel against ONE scratch database**, so a test of a library-wide pass (the clip probe, a backfill) must not assert library-wide counts nor "clear the field" by stamping other rows — both broke here (`captureDays.test.ts` counted 88 seed rows; a `beforeEach` that stamped everyone else's rows would race the other files). Give the pass a scope (`runDeviceProbe({ sessionId })`) and assert inside it. A test writing identical files into one folder also meets the indexer's dedup: give each fixture distinct bytes.
