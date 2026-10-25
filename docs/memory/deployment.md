# Deployment & containers

Read before touching the `Dockerfile`, any compose file, the CI workflows, or anything on the Optiplex / Traefik / Cloudflare path.

Seeded 2026-08-20 from `Dockerfile`, `docker-compose*.yml`, `Makefile`, `.github/workflows/` and `README.md`.

## One image, three roles (2026-08-20)

**The base image is pulled from `mirror.gcr.io`, not Docker Hub** (2026-10-09). The #289 image build failed in 25 s on Docker Hub's `429 Too Many Requests` for `node:24-slim`: anonymous pulls are limited per IP, and GitHub runners share theirs. The gha layer cache does not help, because buildx still resolves the tag with a HEAD request. No image was published, Watchtower kept the old one, and the maintainer redeployed and saw no change. `FROM mirror.gcr.io/library/node:24-slim` is Google's public mirror of the official images: same digest, no account. The rejected alternative is `docker/login-action` to Docker Hub, which needs a secret the maintainer would have to create. **How to apply**: an official base image goes through the mirror. A failed `docker-build.yml` run means production did not change; check it before concluding a deployed fix does not work. CI's `pgvector/pgvector:pg16` service is not an official image and still comes from Docker Hub, so it can hit the same limit (a red CI run, not a silent non-deploy).

**Decision**: a single `node:24-slim` image (Node 22 until 2026-10-09, when 20 was already end of life and 22 in maintenance) serves the Next app, the BullMQ worker and the one-shot `migrate` service; the compose services override `command`. The container runs as **root** on purpose. **Node 24 move, 2026-10-09**: verified only what a container without Docker, Postgres or the NAS can show — `npm ci`, typecheck, tests, `next build`, and a smoke of the two runtime native addons (sharp/libvips, exiftool-vendored via perl; msgpackr-extract under bullmq) on 24.12, 24.18 and 24.21. NOT measured: the worker's RSS under jemalloc and `--max-old-space-size=1024` with V8 13, and the DB-backed tests (skipped without `WINNOW_TEST_DATABASE_URL`). **How to apply**: after a deploy that moves the Node major, watch the worker's memory for a day before trusting it. **Since 2026-10-19 the tag is exact** (`node:24.22.0-slim`, `24.22.1-slim` since 2026-10-21, the portfolio standard's N1 / C14): a floating `24-slim` would have shipped a runtime nobody tested on the next re-pull — spotify-poller's better-sqlite3 abort (nodejs/node#63642, which hits V8-API addons, not N-API ones like sharp) is the measured case. Dependabot raises the minor and patch in a pull request CI builds first (`.github/dependabot.yml`, a `docker` block); the major moves by hand, in `.nvmrc`, the Dockerfile and `@types/node` together. Dependabot does read `mirror.gcr.io`'s tags without credentials (2026-10-21: it opened #331, naming the image `library/node` — see `docs/memory/testing-and-ci.md` trap 3). That #331 moved the image to Node 26 and was merged the same day; the maintainer had it reverted to the newest 24 (2026-10-21) rather than move `.nvmrc`, CI and `@types/node`: a Node major is his call, made with all four, never by a merged bot PR. **Node 26 move, 2026-10-24** (the portfolio's C14 moved to 26 in second-brain#121): `.nvmrc` 26 (both CI jobs read it), `node:26.12.1-slim` (Debian trixie), `@types/node` `^26`, `engines` still ≥ 22, in one PR. Verified here under 26.12.1: lint, typecheck, migrate and the whole suite with the DB-backed tests (against a local `pgvector/pgvector:pg16`), `next build`; the image built (in this sandbox only with its TLS-intercepting proxy's CA injected through a throwaway Dockerfile — apt.postgresql.org otherwise fails certificate verification; nothing of that is committed), and in it sharp/libvips, exiftool-vendored, msgpackr-extract, tsx/esbuild, `pg_dump` 16, `dcraw_emu` and jemalloc load, `/api/health` answers 200 with Postgres and Redis up, and the worker boots. NOT measured, as for 24: the worker's RSS on the real library. **Trap**: npm 11.20 (what 26.12.1 ships) warns at `npm ci` that `esbuild` and `msgpackr-extract` have install scripts "not yet covered by allowScripts"; both work from their prebuilt optional packages today, but if a later npm starts blocking unapproved scripts, check them first.

**Why**: named volumes and NAS mounts (NFS/SMB with their own uid mapping) are writable without friction that way. The maintainer chose fewer permission problems over the usual non-root posture on a single-tenant home box.

**How to apply**: do not add a second image or a non-root user without weighing the mount mapping. The worker runs TypeScript through `tsx` in production and the healthcheck boots a fresh `npx tsx` every 30 s — known cost, "precompile eventually" is P2.

## The system dependencies each answer a specific failure (2026-08-20)

**Decision**: `perl` (exiftool-vendored needs it on Linux), `ffmpeg` (video poster + mp4 proxy), `postgresql-client-16` **from the PGDG repo** (Debian bookworm ships client 15, which refuses to dump a v16 server — this powers the on-demand backup download), `libjemalloc2` (see `docs/memory/pipeline.md`), and on amd64 only `i965-va-driver` + `vainfo`.

**Why the arch guard**: the VAAPI packages do not exist on arm64 (Apple Silicon) and `apt` fails to locate them, so an unguarded install breaks the build on a dev machine. Hardware acceleration is optional anyway — `VIDEO_HWACCEL=none` defaults to software libx264 and needs no `/dev/dri`.

**How to apply**: keep the Postgres client major in lockstep with the compose `postgres` image, or the backup download breaks. A recent Intel iGPU (Gen8+/iHD) needs `intel-media-va-driver-non-free` from non-free instead of `i965`.

## Push to `main` → image → Watchtower → Optiplex (2026-08-20)

**Decision**: `.github/workflows/docker-build.yml` builds on every push to `main` and publishes `ghcr.io/costardrouge/winnow` with `main` + `latest` (moving, what Watchtower re-pulls) and `sha-<short>` (immutable, what you pin for a rollback). An optional `DEPLOY_WEBHOOK_URL`/`DEPLOY_WEBHOOK_TOKEN` pair pokes Watchtower's HTTP API for an instant redeploy; unset, the build still publishes and only the redeploy step is skipped.

**How to apply**: a merge to `main` is a production deploy. To roll back, pin the `sha-` tag rather than reverting and waiting for a rebuild. **A 524 from the redeploy step is not a failed deploy** (2026-10-22): Watchtower's `/v1/update` answers only after the pull and the recreate, and Cloudflare cuts an origin at 100 s — #335's new Node base layer took longer, and the run went red although the image was pushed. The step now treats 524 as a warning (no retry, which would queue a second update), retries only 000/502/503/504, and fails on anything else; the instance's `node` and version on Settings › Instance are what say the deploy landed. The registry-side layer cache is keyed on the workflow run (`type=gha`).

## Network posture: nothing but Traefik reaches the app (2026-08-20)

**Decision**: Traefik + a Cloudflare Tunnel expose the app behind a domain. Ports `3000` / `5432` / `6379` are never published to the Internet; compose binds Postgres/Redis to `127.0.0.1`. Identity now lives in the app itself (see `docs/memory/auth.md`), so the old "trust the reverse proxy" basic-auth is optional rather than load-bearing.

**How to apply**: off-LAN mobile access, including uploads, goes through the tunnel. Do not add a service that expects to be reached directly.

## Two stacks share one base file (2026-08-20)

**Decision**: `docker-compose.yml` is the prod-ish stack (baked build, NAS mounts); `docker-compose.dev.yml` layers on top of it to bind-mount the source, run `next dev` + `tsx watch`, and redirect the three "NAS" mounts to local `./nas`, `./nas-incoming`, `./nas-final` **regardless of what `NAS_*` says in `.env`**. `docker-compose-optiplex.yml` is the real production file. `make help` lists the wrappers.

**Why the anonymous volumes**: the dev override mounts `/app/node_modules` and `/app/.next` as anonymous volumes so the image's native builds shadow the host copies — otherwise a host `node_modules` built on macOS breaks sharp inside the container.

**How to apply**: only the first dev run needs `--build` (system deps + `npm ci`); afterwards code hot-reloads and only a `package.json` change requires another build. `restart: "no"` on dev app/worker is deliberate — a crash while editing should not restart-loop.

**Trap**: multi-hour ffmpeg jobs run against BullMQ's default 30 s lock, and compose sets no `stop_grace_period`, so Docker's 10 s default SIGKILLs a long transcode on deploy (review R8, P1).

**The worker migrates at boot (2026-10-11, D6 answered)**: Watchtower recreates the labelled `app` and `worker` on a new image but never re-runs the exited one-shot `migrate` — confirmed when 0048/0049 shipped unapplied and the indexer failed on 9 124 files for a day (`column "device_exif" does not exist`). `src/worker.ts` now runs `migrate()` before creating any Worker, under a session `pg_advisory_lock` that serialises it with the compose one-shot (whichever wins applies, the other finds nothing to do); a failed migration exits the worker rather than run code against the wrong schema. **How to apply**: a migration needs nothing more than its file — but the APP may serve the new code for the seconds before the worker finishes, so a migration that makes the new code's queries valid must stay quick, and anything long belongs in a job, not a migration. `docker-build.yml` still publishes whether or not CI passed (SCL-02, D7 open). To verify a deploy from a cloud session, read a new column through the API with `WINNOW_TOKEN` (`/api/assets?limit=1`): that is how this one was found.


## Versions and releases ride beside the deploy, not in front of it (2026-10-17)

**Decision**: `package.json`'s version is the product's (C13 in `second-brain`); `.github/workflows/release.yml` + `.github/release.mjs` (identical in every repo) check `CHANGELOG.md` on every pull request and, on `main`, tag and publish the section `package.json` names. The deploy did not change: every push to `main` still builds `:latest` and Watchtower pulls it, released or not. The version is read at build time through `src/lib/version.ts` (a *named* JSON import, so the client bundle carries the string only — checked: no `devDependencies` in `.next/static`) and shown at the foot of the account menu.

**Why**: the maintainer wants to know which build the Optiplex runs and his site to show each project's history; slowing deploys to releases is a later choice per project.

**How to apply**: a release is its own PR (version + changelog, nothing else). The backfilled 0.1.0–0.10.0 are tagged by `second-brain`'s "Backfill releases" workflow, never by `release.yml` (GitHub refuses its token a tag on a commit whose workflows differ from `main`'s). When deploys follow releases, `docker-build.yml` should also push `:x.y.z`, and a GITHUB_TOKEN release triggers no workflow: the build has to run inside `release.yml`'s publish job or be called from it.

2026-10-24 (rev. 2026-10-25) — **The shared workflows** (`.github/workflows/registry.yml`, `release.yml`, `.github/release.mjs`) are copied byte for byte from `second-brain/system/meta/common-project-spec/shared/`, never from another repo; their `check` jobs, and since 2026-10-25 (option C) the writing `send` and `publish` jobs too, run on `vars.CI_RUNNER || 'ubuntu-24.04'`, which only the private repos set; this repo is public, so every job stays hosted.
