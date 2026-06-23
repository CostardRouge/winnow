# Winnow — single image shared by the Next.js app and the BullMQ workers.
# The worker runs the TypeScript via tsx (runtime dependency), the app serves the
# Next build. We stay as root: named volumes and NAS mounts (NFS/SMB, with their
# own uid mapping) are thus writable without friction.
FROM node:22-slim

# System dependencies:
#  - perl            : required by exiftool-vendored on Linux.
#  - ffmpeg          : video derivatives (poster + mp4 proxy).
#  - libjemalloc2    : drop-in malloc (LD_PRELOAD'd below). sharp/libvips churns
#    through large short-lived buffers; glibc's default allocator fragments under
#    that and never returns the freed pages to the OS, so the worker's RSS climbs
#    and stays high. jemalloc keeps it flat (multi-arch: amd64 + arm64).
#  - i965-va-driver  : VAAPI driver (Intel ≤ Gen8) for hardware encoding
#    + vainfo        : VAAPI diagnostics (`vainfo` inside the container).
# The VAAPI bits are Intel/x86-only: they exist on amd64 but NOT on arm64
# (Apple Silicon, etc.), where apt would fail to locate them. They are installed
# only on amd64; everywhere else ffmpeg encodes in software. Hardware
# acceleration stays OPTIONAL anyway (VIDEO_HWACCEL=none by default → software
# ffmpeg libx264, works without /dev/dri). For a recent Intel iGPU (Gen8+ / iHD),
# add `intel-media-va-driver-non-free` (non-free repo).
RUN apt-get update \
  && apt-get install -y --no-install-recommends perl ffmpeg libjemalloc2 \
  && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
       apt-get install -y --no-install-recommends i965-va-driver vainfo; \
     fi \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Dependencies — cached layer as long as the manifests don't change.
#    npm ci = reproducible install from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# 2) Code + build of the Next app.
COPY . .
RUN npm run build

# Memory hygiene for the long-lived worker (and harmless for the web app):
#  - LD_PRELOAD jemalloc by its bare soname so the dynamic linker resolves it via
#    the ldconfig cache regardless of arch (no hard-coded /usr/lib/<triplet> path).
#  - MALLOC_ARENA_MAX caps glibc's per-thread arenas as a fallback for any process
#    where jemalloc isn't preloaded; jemalloc ignores it, so the two compose safely.
ENV NODE_ENV=production \
    PORT=3000 \
    LD_PRELOAD=libjemalloc.so.2 \
    MALLOC_ARENA_MAX=2
EXPOSE 3000

# Liveness probe (native Node 22 fetch, no external binary required).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default command: the web app. The worker/migrate services override `command`.
CMD ["npm", "run", "start"]
