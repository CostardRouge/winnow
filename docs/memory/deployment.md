# Deployment & containers

Read before touching the `Dockerfile`, any compose file, the CI workflows, or anything on the Optiplex / Traefik / Cloudflare path.

Seeded 2026-08-20 from `Dockerfile`, `docker-compose*.yml`, `Makefile`, `.github/workflows/` and `README.md`.

## One image, three roles (2026-08-20)

**Decision**: a single `node:22-slim` image serves the Next app, the BullMQ worker and the one-shot `migrate` service; the compose services override `command`. The container runs as **root** on purpose.

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
