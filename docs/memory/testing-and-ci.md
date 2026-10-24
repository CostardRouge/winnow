# Verification, CI, and what green does not prove

Read before deciding a change is "done", or before touching `.github/workflows/`.

Seeded 2026-08-20 from `.github/workflows/ci.yml`, `CONTRIBUTING.md`, `package.json` and `docs/ARCHITECTURE-REVIEW.md` §3.5.

## The gate is four commands, and CI runs all four (2026-08-20, revised 2026-10-19)

**Decision**: `npm run typecheck` (`tsc --noEmit`), `npm test`, `npm run migrate` (against a real Postgres — the SQL is part of the contract), `npm run build`. CI runs exactly these: a fast `typecheck` job with no services, and a `build` job with a `pgvector/pgvector:pg16` service that it migrates, runs the whole suite against (`WINNOW_TEST_DATABASE_URL` set to that database, so the database-backed tests run there — and nowhere else by accident, since they never read `DATABASE_URL`), then builds. The tests joined the gate on 2026-10-19 under the portfolio standard (C15 in `COMMON-PROJECT-SPEC.md`, `second-brain`: a pull request is gated on lint, typecheck, tests and build), which settled decision D8 of `docs/CODEBASE-AUDIT.md` the way it recommended — `npm test` in the `build` job, because that job has the Postgres.

**How to apply**: run them locally before committing; a red one is a broken PR, and CI cancels superseded PR runs but never cancels a run on `main`. The job names (`Typecheck`, `Build & migrations`) stay as they are: a branch-protection rule lists its required checks by name. `paths-ignore` skips CI entirely for `**/*.md`, `docs/**` and `LICENSE` — a docs-only change gets no CI run at all, which is fine but means "CI passed" is not a statement about it.

## Biome lints `src/`; a young test suite, in CI since 2026-10-19 (2026-08-20, revised 2026-10-19)

**Lint**: since 2026-10-19 Biome lints `src/` (`npm run lint`, in CI's `typecheck` job) under its recommended rules — the portfolio standard's N3 (C14): Biome rather than the ESLint-for-hooks-and-a11y the audit's D9 proposed, because the standard says Biome for a repo that had none and one tool will lint and format. `biome.jsonc` is scoped to `src/`, parses the stylesheet with `css.parser.tailwindDirectives` (without it Tailwind 4's `@theme` / `@utility` blocks were 1 276 parse errors), keeps the formatter off (a repo-wide reformat is its own PR), and switches off — each with its count on that day — what a first run reported and would have meant a rewrite: the a11y group's 494 (useButtonType 307, noSvgWithoutTitle 63, useSemanticElements 51, noStaticElementInteractions 25, useKeyWithClickEvents 14, noLabelWithoutControl 13, noAutofocus 12, three smaller ones — the audit's batch 7), useExhaustiveDependencies 65 (D9's hook arrays), noNonNullAssertion 353, useImportType 95 (a safe autofix, to land with the formatter), noExplicitAny 30, noImgElement 27 (`next/image` is off on purpose, SEC-02), useOptionalChain 25, noImplicitAnyLet 14, noArrayIndexKey 9, useTemplate 9, noConfusingVoidType 4; the cascade rules for `globals.css`; and useHookAtTopLevel for the tests (`useTestDatabase()` is a helper, not a hook) and for `MediaViewer.tsx` alone. What the first run fixed, by hand or by Biome's own safe fix: `forEach` callbacks returning a value, `??=` used as an expression, a shadowed `Error`, two dead symbols, four regex literals, the MCPB placeholders written as escaped templates, and the four deliberate `dangerouslySetInnerHTML` carry a `biome-ignore` with their reason (that rule stays on). **How to apply**: re-enable one rule, fix what it reports, delete its line in `biome.jsonc`; convert the 51 dead `eslint-disable` comments (21 `react-hooks/exhaustive-deps`, 26 `@next/next/no-img-element`, 4 `no-var`) to `biome-ignore` with a reason only when their rule comes back. **The one real finding left open**: `MediaViewer.tsx` calls seven hooks (the faces layer, the image-box measure) after `if (!item) return null;` — React's rules of hooks; harmless while the viewer never renders with a missing item, a hook-count error the day it does; the fix is the viewer's own rework, not a lint sweep.

**Tests**: since 2026-10-02, `npm test` runs `tsx --test "src/**/*.test.ts"`: Node's built-in `node:test` + `node:assert/strict`, through the `tsx` that is already a runtime dependency — **no test package was added**, which is why it was chosen over vitest/jest. Tests sit next to the module they test (`src/lib/authz.test.ts`).

**DB-backed tests are opt-in**: they run only when `WINNOW_TEST_DATABASE_URL` is set, and point `DATABASE_URL` at it before importing anything — never at whatever database the shell happens to have, because a test that inserts rows must not be able to land them in a real library. Without it they **skip and say so**. Locally: a migrated scratch database (`npm run migrate` against it first).

**Consequences to hold in mind**: coverage is thin (the role policy and the batch-1 regression tests), so most refactors still have only the type checker behind them. "It builds" means it compiles; for anything user-visible, look at it in the browser. CI runs `npm test` since 2026-10-19 (the section above): what a green run proves is bounded by that thin coverage, not by the gate.

**How to apply**: a bug fix ships with a test that fails without it. Good next seams, pure and mock-free: `categorizeAsset`, `includeFromParams`, `snapToCell`, `lineageRole`, burst clustering, filter building, the pure half of `lib/timeline.ts`.

## The CI environment is a deliberate mirror of production (2026-08-20)

**Decision**: CI runs the Node of `.nvmrc` (26 — since 2026-10-19 the one place the major is written for CI and a local `nvm use`), the major the runtime image pins exactly (`node:26.12.1-slim`, `Dockerfile`); both moved from 22 to 24 on 2026-10-09 and to 26 on 2026-10-24; `engines` keeps the floor at 22, and `@types/node` is `^26` to match, held to that major by Dependabot; the Postgres service is pgvector-on-16 to match both the compose image major and the extension the CLIP migration needs.

**Why**: CI is meant to validate what ships. Drifting the Node major or the Postgres major would make a green build meaningless for the box it deploys to.

**How to apply**: Dependabot raises the image's Node minor and patch, the packages and the actions; a Node major moves by hand, in one commit — `.nvmrc`, the `Dockerfile` tag, and `@types/node` (`dependabot.yml` holds the majors of both); a Postgres major moves the `Dockerfile` (`postgresql-client-16`), the compose `postgres` image and CI's service together. See `docs/memory/deployment.md` for why the Postgres client major must track the server major.

**One difference the runner does carry, found the day the tests joined the gate (2026-10-20)**: the Ubuntu runner runs under `C.UTF-8`, and Debian's `unzip` 6.0 in a UTF-8 locale re-encodes a flagged UTF-8 entry name from CP437 (`Café — été.jpg` becomes `Caf├й…`, `-p <name>` matches nothing) while in the C locale, or in a container with no locale set, the bytes pass through — so `src/lib/zip.test.ts` was green locally and red on the runner. The archive is right (bit 11 set, `-t` passes); a test that spawns `unzip` passes it `LC_ALL=C`. The same trap waits for any test that shells out to a tool reading file names in a locale: pin the locale in the spawn, never in the workflow.

## Measuring without the Optiplex, and a file search skips (2026-10-02)

**How**: a container with Postgres 16 + Redis is enough to run `next start` and measure for real — seed a synthetic library (`generate_series` into `roots`/`sessions`/`assets`/`ratings`; the CHECK lists are in the migrations) and time routes with `curl -w %{time_total}`, `EXPLAIN (ANALYZE, BUFFERS)` the SQL `buildFilter` emits, and drive the UI with Playwright's Chromium. `docs/CODEBASE-AUDIT.md` §1 lists what that setup cannot see (production `pg_stat_*`, NAS latency, Traefik/Watchtower config) — state those limits next to any number.

**Trap**: `src/lib/lensLabels.ts` contains literal NUL bytes (lines 116, 127), so git shows it as binary, `grep` says "binary file matches" and ripgrep **skips it silently**. Search with `grep -a` / `rg -a` until DX-03 escapes them.


## `next dev` edits two tracked files: never commit them (2026-10-09)

**Trap**: running `next dev` (16.x) appends a `nextjs-agent-rules` block to `CLAUDE.md` and rewrites `next-env.d.ts` to `./.next/dev/types/…`. Both are tooling noise: leave them unstaged and `git checkout --` them once the dev server is stopped (it re-adds them while running). The block's own text says committing it "keeps the tree clean" — that is the generator talking, not a project rule. A browser check of a page — and every DB-backed test — needs Postgres 16 **with pgvector** (`apt-get install postgresql-16-pgvector`; four migrations need it; where apt has no such package, as in a cloud container (2026-10-11), `postgresql-server-dev-16` + `git clone --branch v0.8.0 pgvector` + `make install` takes a minute), a Redis, and a session cookie minted with `createSession()` from `lib/auth.ts`.

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

## The portfolio standard applied (2026-10-19)

**Decision**: `COMMON-PROJECT-SPEC.md` in `second-brain` (C14–C19, the decisions N1–N3, K1, K2, K6, A2) is in force here since 2026-10-19, in one branch of five commits. What it put in place: the visibility (PUBLIC) and the trailer rule in `CLAUDE.md`, the canonical `/memorize`, `AGENTS.md` confirmed a symlink; the tests in CI's `build` job against its Postgres (the section above); Biome over `src/` as the gate's first command (the section above); Node pinned — `.nvmrc` 24 read by both CI jobs, `engines` ≥ 22, the image on `node:24.22.0-slim` — and Dependabot on npm, the actions and the image, `@types/node` and the image's major held (`docs/memory/deployment.md`); the data statement (C18) in `CLAUDE.md`'s Context, pointing at `docs/BACKUP.md`. Left where the audit had already filed it: the security headers (SEC-08, batch 2, the maintainer's approval). Not applicable: C17's public-page items — the app is behind a login, so no SEO, legal notice, analytics or second language.

**Traps met**: (1) a lint fix that touches `src/lib/commands/mcp.ts` turns `the bridge number is bumped whenever the bridge changes` red — the test pins the bridge's source hash; when the bundled manifest is byte-identical, update `BRIDGE_SOURCE_HASH` alone, as the test's message says, and bump the number only when what an agent installs changes. (2) `node .github/release.mjs check` fails in a shallow clone (every backfilled section "names a commit not in history"): CI, which fetches the full history, is the judge; a local failure of only those lines is not a changelog defect. (3) Dependabot names the image pulled through Google's mirror `library/node` (#331, 2026-10-21 — it does read the mirror's tags), not `mirror.gcr.io/library/node` as assumed: the major ignore must name all three spellings, or a Node major slips through. (4) `next build` on Node 22 in a container is a valid check of the code, not of the image: the first CI run on `main`'s Node 24 and `docker-build.yml` are what prove a tag change pulls.

## Dependabot — the portfolio's C20 (2026-10-21)

**Decision**: `.github/dependabot.yml` is C20's canonical file trimmed to npm, github-actions and docker: monthly, `cooldown` 7 days (30 for a major), one `minor-and-patch` group for production and development together (the old `dev-dependencies` group split by `dependency-type` is gone), major-only family groups `react`, `next`, `tailwind` and `aws-sdk` (the S3 client and its presigner share a train) listed before it, `open-pull-requests-limit: 3`, a `security` group. Held majors: `@types/node` (follows `.nvmrc`) and the Node image under `library/node`, `mirror.gcr.io/library/node` and `node` (trap 3 above). No `docker-compose` block: the compose files pin Postgres/Redis majors, and a Postgres major is a dump/restore done by hand.
**Why**: weekly runs piled up red PRs across the portfolio; a monthly grouped PR is one review, and the cooldown lets a broken release be yanked before it lands.
**How to apply**: a red Dependabot PR is never merged nor left open — fix the repo in its own PR, or hold the version with an `ignore` (its reason in a comment, plus an entry here saying when to lift it) and close the PR. Never push to Dependabot's branch. No auto-merge. `portfolio-check`'s F2 reads this file by text: keep `cooldown:`, `minor-and-patch:`, and the `@types/node` and `node` ignores.
