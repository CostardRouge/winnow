# Verification, CI, and what green does not prove

Read before deciding a change is "done", or before touching `.github/workflows/`.

Seeded 2026-08-20 from `.github/workflows/ci.yml`, `CONTRIBUTING.md`, `package.json` and `docs/ARCHITECTURE-REVIEW.md` §3.5.

## The gate is three commands, and that is the whole gate (2026-08-20)

**Decision**: `npm run typecheck` (`tsc --noEmit`), `npm run migrate` (against a real Postgres — the SQL is part of the contract), `npm run build`. CI runs exactly these: a fast `typecheck` job with no services, and a `build` job with a `pgvector/pgvector:pg16` service.

**How to apply**: run them locally before committing; a red one is a broken PR, and CI cancels superseded PR runs but never cancels a run on `main`. `paths-ignore` skips CI entirely for `**/*.md`, `docs/**` and `LICENSE` — a docs-only change gets no CI run at all, which is fine but means "CI passed" is not a statement about it.

## There is no linter and no test suite (2026-08-20)

**Fact, not preference**: no ESLint config exists — the CI file says so in a comment, and `tsc --noEmit` is the static gate. Zero automated tests exist and there is no test runner, no `npm test`, no `make test`.

**Consequences to hold in mind**: a refactor has only the type checker behind it. Nothing catches a behavioural regression in a pure function, an SQL result shape that still type-checks, or a UI interaction. "It builds" means it compiles, not that it works — for anything user-visible, look at it in the browser before calling it done.

**If you are asked to add tests**: the review names the natural starting points, pure functions needing no mocks — `categorizeAsset`, `includeFromParams`, `snapToCell`, `lineageRole`, `requiredRole`, burst clustering, filter building. Adding the first test also means choosing a runner and adding a CI job, which is a decision for the maintainer, not a chore to slip into another commit. Tracked as an open item in `MEMORY.md`.

## The CI environment is a deliberate mirror of production (2026-08-20)

**Decision**: Node 22 in CI matches the `node:22-slim` runtime image; the Postgres service is pgvector-on-16 to match both the compose image major and the extension the CLIP migration needs.

**Why**: CI is meant to validate what ships. Drifting the Node major or the Postgres major would make a green build meaningless for the box it deploys to.

**How to apply**: if you bump one, bump the others in the same commit — `Dockerfile` (`node:22-slim`, `postgresql-client-16`), the compose `postgres` image, and both CI jobs. See `docs/memory/deployment.md` for why the Postgres client major must track the server major.
