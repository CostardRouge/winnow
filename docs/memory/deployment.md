# Deployment & containers

Read before touching the `Dockerfile`, any compose file, the CI workflows, or anything on the Optiplex / Traefik / Cloudflare path.

Seeded 2026-08-20 from `Dockerfile`, `docker-compose*.yml`, `Makefile`, `.github/workflows/` and `README.md`.

## One image, three roles (2026-08-20)

**The base image is pulled from `mirror.gcr.io`, not Docker Hub** (2026-10-09). The #289 image build failed in 25 s on Docker Hub's `429 Too Many Requests` for `node:24-slim`: anonymous pulls are limited per IP, and GitHub runners share theirs. The gha layer cache does not help, because buildx still resolves the tag with a HEAD request. No image was published, Watchtower kept the old one, and the maintainer redeployed and saw no change. `FROM mirror.gcr.io/library/node:24-slim` is Google's public mirror of the official images: same digest, no account. The rejected alternative is `docker/login-action` to Docker Hub, which needs a secret the maintainer would have to create. **How to apply**: an official base image goes through the mirror. A failed `docker-build.yml` run means production did not change; check it before concluding a deployed fix does not work. CI's `pgvector/pgvector:pg16` service is not an official image and still comes from Docker Hub, so it can hit the same limit (a red CI run, not a silent non-deploy).

**Decision**: a single `node:24-slim` image (Node 22 until 2026-10-09, when 20 was already end of life and 22 in maintenance) serves the Next app, the BullMQ worker and the one-shot `migrate` service; the compose services override `command`. The container runs as **root** on purpose. **Node 24 move, 2026-10-09**: verified only what a container without Docker, Postgres or the NAS can show — `npm ci`, typecheck, tests, `next build`, and a smoke of the two runtime native addons (sharp/libvips, exiftool-vendored via perl; msgpackr-extract under bullmq) on 24.12, 24.18 and 24.21. NOT measured: the worker's RSS under jemalloc and `--max-old-space-size=1024` with V8 13, and the DB-backed tests (skipped without `WINNOW_TEST_DATABASE_URL`). **How to apply**: after a deploy that moves the Node major, watch the worker's memory for a day before trusting it; the tag floats on the 24 line (as `22-slim` did), so a Node-level regression like spotify-poller's better-sqlite3 abort (nodejs/node#63642, which hits V8-API addons, not N-API ones like sharp) would arrive with a re-pull — pin the exact version in the Dockerfile if one ever does.

**Why**: named volumes and NAS mounts (NFS/SMB with their own uid mapping) are writable without friction that way. The maintainer chose fewer permission problems over the usual non-root posture on a single-tenant home box.

**How to apply**: do not add a second image or a non-root user without weighing the mount mapping. The worker runs TypeScript through `tsx` in production and the healthcheck boots a fresh `npx tsx` every 30 s — known cost, "precompile eventually" is P2.

## The system dependencies each answer a specific failure (2026-08-20)

**Decision**: `perl` (exiftool-vendored needs it on Linux), `ffmpeg` (video poster + mp4 proxy), `postgresql-client-16` **from the PGDG repo** (Debian bookworm ships client 15, which refuses to dump a v16 server — this powers the on-demand backup download), `libjemalloc2` (see `docs/memory/pipeline.md`), and on amd64 only `i965-va-driver` + `vainfo`.

**Why the arch guard**: the VAAPI packages do not exist on arm64 (Apple Silicon) and `apt` fails to locate them, so an unguarded install breaks the build on a dev machine. Hardware acceleration is optional anyway — `VIDEO_HWACCEL=none` defaults to software libx264 and needs no `/dev/dri`.

**How to apply**: keep the Postgres client major in lockstep with the compose `postgres` image, or the backup download breaks. A recent Intel iGPU (Gen8+/iHD) needs `intel-media-va-driver-non-free` from non-free instead of `i965`.

## Push to `main` → image → Watchtower → Optiplex (2026-08-20)

**Decision**: `.github/workflows/docker-build.yml` builds on every push to `main` and publishes `ghcr.io/costardrouge/winnow` with `main` + `latest` (moving, what Watchtower re-pulls) and `sha-<short>` (immutable, what you pin for a rollback). An optional `DEPLOY_WEBHOOK_URL`/`DEPLOY_WEBHOOK_TOKEN` pair pokes Watchtower's HTTP API for an instant redeploy; unset, the build still publishes and only the redeploy step is skipped.

**How to apply**: a merge to `main` is a production deploy. To roll back, pin the `sha-` tag rather than reverting and waiting for a rebuild. The registry-side layer cache is keyed on the workflow run (`type=gha`).

## Network posture: nothing but Traefik reaches the app (2026-08-20)

**Decision**: Traefik + a Cloudflare Tunnel expose the app behind a domain. Ports `3000` / `5432` / `6379` are never published to the Internet; compose binds Postgres/Redis to `127.0.0.1`. Identity now lives in the app itself (see `docs/memory/auth.md`), so the old "trust the reverse proxy" basic-auth is optional rather than load-bearing.

**How to apply**: off-LAN mobile access, including uploads, goes through the tunnel. Do not add a service that expects to be reached directly.

## Two stacks share one base file (2026-08-20)

**Decision**: `docker-compose.yml` is the prod-ish stack (baked build, NAS mounts); `docker-compose.dev.yml` layers on top of it to bind-mount the source, run `next dev` + `tsx watch`, and redirect the three "NAS" mounts to local `./nas`, `./nas-incoming`, `./nas-final` **regardless of what `NAS_*` says in `.env`**. `docker-compose-optiplex.yml` is the real production file. `make help` lists the wrappers.

**Why the anonymous volumes**: the dev override mounts `/app/node_modules` and `/app/.next` as anonymous volumes so the image's native builds shadow the host copies — otherwise a host `node_modules` built on macOS breaks sharp inside the container.

**How to apply**: only the first dev run needs `--build` (system deps + `npm ci`); afterwards code hot-reloads and only a `package.json` change requires another build. `restart: "no"` on dev app/worker is deliberate — a crash while editing should not restart-loop.

**Trap**: multi-hour ffmpeg jobs run against BullMQ's default 30 s lock, and compose sets no `stop_grace_period`, so Docker's 10 s default SIGKILLs a long transcode on deploy (review R8, P1).

**The worker migrates at boot (2026-10-11, D6 answered)**: Watchtower recreates the labelled `app` and `worker` on a new image but never re-runs the exited one-shot `migrate` — confirmed when 0048/0049 shipped unapplied and the indexer failed on 9 124 files for a day (`column "device_exif" does not exist`). `src/worker.ts` now runs `migrate()` before creating any Worker, under a session `pg_advisory_lock` that serialises it with the compose one-shot (whichever wins applies, the other finds nothing to do); a failed migration exits the worker rather than run code against the wrong schema. **How to apply**: a migration needs nothing more than its file — but the APP may serve the new code for the seconds before the worker finishes, so a migration that makes the new code's queries valid must stay quick, and anything long belongs in a job, not a migration. `docker-build.yml` still publishes whether or not CI passed (SCL-02, D7 open). To verify a deploy from a cloud session, read a new column through the API with `WINNOW_TOKEN` (`/api/assets?limit=1`): that is how this one was found.

