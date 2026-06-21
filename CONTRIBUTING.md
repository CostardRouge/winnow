# Contributing to Winnow

Thanks for your interest in improving Winnow! This guide covers how to get a dev
environment running, the checks your change has to pass, and the conventions the
project follows. For *what* Winnow is and *how* it's architected, read the
[README](README.md) first.

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).

---

## Getting set up

Winnow is a [Next.js](https://nextjs.org) (App Router) + TypeScript app backed by
**Postgres** and a **Redis/BullMQ** queue. You need Node 22 (matches CI and the
runtime image) plus a reachable Postgres and Redis.

The quickest path is the fully-local Docker stack — it brings up Postgres, Redis
and the workers and hot-reloads your source edits:

```bash
cp .env.dist .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Or run it on the host against your own Postgres/Redis:

```bash
npm install
cp .env.dist .env       # adapt DATABASE_URL / REDIS_URL to localhost
npm run migrate         # apply the SQL schema
npm run dev             # UI + API on http://localhost:3000
npm run worker          # in another terminal: the BullMQ workers
```

See the [README "Getting started"](README.md#getting-started) section for the
full set of options (NAS mounts, the standalone compose, sample media, …).

### Configuration

All configuration is read from the environment and **validated at startup** in
[`src/lib/config.ts`](src/lib/config.ts) (via `zod`). Every variable is
documented in [`.env.dist`](.env.dist); an empty value falls back to a sensible
default, but a malformed one (bad number, unknown enum, wrong URL scheme) aborts
the process with a readable error. When you add a new environment variable:

1. add it to the `envSchema` in `src/lib/config.ts` (with a default and bounds),
2. expose it on the exported `config` object,
3. document it in `.env.dist`.

---

## Before you open a PR

CI runs on every pull request (`.github/workflows/ci.yml`). Run the same checks
locally so there are no surprises — there is **no ESLint config**; `tsc` is the
static gate:

```bash
npm run typecheck       # tsc --noEmit — must pass
npm run migrate         # applies/validates the SQL (the schema is part of the contract)
npm run build           # production build — must succeed
```

A change is ready when all three are green.

### Database migrations

The SQL migrations live in `db/migrations/` and are applied in lexicographic
order by `npm run migrate` (each applied file is recorded in
`schema_migrations`). Migrations are **append-only and ordered** — add a new
file with the next free number (`NNNN_*.sql`, after the highest one already in
`db/migrations/`) rather than editing an existing one, since other environments
have already applied the earlier ones. CI runs the migrations against a real
Postgres, so a broken or out-of-order migration fails the build.

---

## Conventions

- **TypeScript everywhere**, ES modules. Keep things strictly typed — `tsc` is the
  guardrail.
- **Comments explain the *why*.** The codebase favours short comments that capture
  intent and trade-offs (why a derivative is built on a proxy, why a path is
  guarded), not restatements of the code. Match that style.
- **Respect the guiding principle:** the RAWs/originals on the NAS are touched
  **once** (index + derivative generation). Browsing, culling and queries go
  through Postgres and the derivative cache; deletes are *soft* deletes. A change
  that mutates or re-reads originals needs a very good reason.
- **Keep secrets out of the client bundle.** `src/lib/config.ts` is server-only
  (it holds the S3 credentials). Only `NEXT_PUBLIC_*` variables may be read from
  client components.

### Commits and pull requests

- Branch off `main`; keep your branch focused on one change.
- Write imperative, sentence-case commit/PR titles describing the user-visible
  effect (e.g. *"Reflect Library UI state in the URL"*), matching the existing
  history.
- Explain the *why* in the PR description, and include screenshots / clips for UI
  changes.
- Make sure `typecheck`, `migrate` and `build` pass before requesting review.

---

## Reporting bugs and proposing features

Open an issue describing what you expected, what happened, and how to reproduce
it (OS, Node version, relevant `.env` settings, and any logs from the app or the
worker). For features, describe the workflow you're trying to support — Winnow is
opinionated about the ingest → cull → export pipeline, so context helps a lot.

Thanks for contributing! 🪶
