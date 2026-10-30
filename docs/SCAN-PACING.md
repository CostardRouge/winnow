# Scan pacing — reactive without the fan

*Written 2026-10-30 as a brief, **nothing built yet**. The maintainer's ask:
"organise how files are scanned so it is very reactive, and orchestrate it
better: sometimes the machine blows hard — there are probably better
strategies to scan gently, over time, while staying reactive, rather than load
peaks and the fan climbing for a while". §2 says why the box peaks today, read
from the code; §3–§4 are the strategy; §5 orders it into pull requests; §6 is
what only the maintainer can decide; §8 is how he runs it, from a local
Claude Code session on the Optiplex. It builds on two findings already filed
and never built: ARC-03 (`pace(stage)`, `docs/CODEBASE-AUDIT.md`) and E19
(quiet hours, `docs/SETTINGS-UI.md`), and on review items C5 and C8
(`docs/ARCHITECTURE-REVIEW.md`).*

---

## 1. What the pipeline does today

**Detection.** Four ways a file is noticed (`src/worker.ts`, `lib/bootstrap.ts`,
`lib/import.ts`, `lib/watcher.ts`):

| Trigger | Scope | Delay before a new file is seen |
|---|---|---|
| Worker boot (every Watchtower deploy) | every watched root, whole walk | — |
| Periodic tick, `rescanMinutes` (default 60) | every watched root, whole walk | up to 60 min + its turn in the walk |
| Import / upload / inbox (chokidar on the local inbox) | **the whole incoming root**, priority high | the walk of the whole root |
| API (re-index, retry, add a volume) | one root, whole walk | idem |

There is no watcher on the NAS mounts: they are NFS 4.1
(`docker-compose-optiplex.yml`, volumes `nas`, `nas_incoming`) and inotify does
not cross NFS. That is correct and stays (`docs/memory/pipeline.md`, "A moved
original deadlocks the pipeline").

**Work.** One worker process, nine BullMQ queues (review §1). The heavy ones
for the box:

| Stage | What burns | Concurrency | Pace (default) |
|---|---|---|---|
| index (new/changed file) | NFS read of 128 KiB + exiftool | 1 | `scanPerHour` = **0, unlimited** |
| derivatives, photo | sharp decode of the preview; a Sony .hif is a ~2.8 s WASM decode in a child; a preview-less DNG a `dcraw_emu` demosaic | 3 | `analyzePerHour` = **0, unlimited** |
| derivatives, video | ffmpeg `thumbnail=n=50` over the stream, then a **libx264 software transcode** (`VIDEO_HWACCEL=none` by default), up to 1 h per clip | 3 (shared with photos) | idem |
| ML | the immich-ml container (ONNX, its own threads) | 1 | `mlPerHour` = 1200 |
| geocode | network, a DB write | 1 | 3600/h |
| integrity, relink, probes | a walk + a stat or a few KB per file | 1 | the scan's budget |

**Pacing.** `lib/rate.ts` reserves a slot every `3 600 000 / perHour` ms
(a spacing, not a bucket: no burst at all once a rate is set). Five sites call
it, in two styles (ARC-03): derivatives and GPS write re-queue through
`Worker.rateLimit()`; index, ML and geocode hold their slot in a sleep loop.
`getSettings()` falls back to the defaults — no pause, no limit — on any
Postgres error (C8).

## 2. Findings — why the box blows

**P1 — The two stages that read and decode are unlimited by default.**
`scanPerHour` and `analyzePerHour` both default to 0 (`lib/settings.ts:50`).
A card offload of 2 000 files is read flat out, then derived three at a time
flat out. Only ML is paced. The peak is the default behaviour, not an accident.

**P2 — The video transcode is the peak, and it is also the slowest path to a
thumbnail.** `makeVideoProxy` (`lib/video.ts`) runs libx264 with no `-threads`,
so each ffmpeg takes every core (libx264's default is ~1.5× the core count),
and `DERIVATIVE_CONCURRENCY=3` can run three at once: the CPU is oversubscribed
for as long as a 4K clip takes to encode. Worse for reactivity,
`generateVideoDerivative` (`lib/derivatives.ts:147-155`) writes `thumb_key` only
after the proxy exists, so a clip has **no grid poster** until its whole
transcode ends. The iGPU is wired (`/dev/dri` shared, `i965-va-driver` in the
image) but VAAPI is off unless `.env` turns it on — `/settings/instance` says
which on the Optiplex.

**P3 — A rate counts jobs, not work.** A JPEG thumbnail (~0.2 s), a Sony .hif
(~3 s), a DNG demosaic (~10 s) and a 4K clip (minutes) each cost one slot. A
cap low enough to keep video quiet starves photos; a cap that keeps photos
reactive lets video cook the box. No flat per-hour number can be both smooth
and reactive — which is why it stays at 0.

**P4 — Nothing tells the kernel what is background.** ffmpeg, `dcraw_emu`, the
HEIF child and exiftool run at nice 0, like the web app and Postgres; the
worker has a `mem_limit` but no CPU cap, so nothing bounds the package power —
and package power is what the fan follows. (`ionice` would only help the
Optiplex's own disk — derivative cache, Postgres, temp files — never the NAS
HDD, which sits behind NFS; the NAS is paced by rate or not at all.)

**P5 — The periodic rescan is a full walk, every hour.** Before the stat gate,
each file costs a `stat` over NFS **and two Postgres round trips**
(`ensureSession` and the `existing` lookup, `lib/indexer.ts:220-237`). On a
library past 100 000 media that is over 200 000 queries and 100 000 NFS `GETATTR`s
per tick to find, usually, nothing. Cheap for the HDD (no hashing), not for the
CPU: an hourly bump of node + Postgres, and a long walk.

**P6 — Reactivity is bounded by that same walk.** A file copied straight into
`/nas-incoming` (a phone backup, a Finder copy — not the inbox) waits up to an
hour, then its place in a six-figure walk. An import that wrote 300 files
into one dated folder enqueues a scan of the **whole** incoming root
(`lib/import.ts:339`): it already knows the folders it wrote, and throws that
away.

**P7 — Bulk re-enqueues inherit the unlimited default.** Regenerate, Retry,
the bootstrap's stuck/orphan pass, the integrity rebuild and a session's
"derive" (`api/assets/regenerate`, `api/failures/retry`, `lib/bootstrap.ts`,
`lib/integrity.ts`, `api/sessions/[id]`) enqueue at normal priority into an
unpaced queue: hours at full CPU, and a new card waits behind them only
because `high` priority happens to be set on incoming.

**P8 — Stages do not share a budget.** A scan, three derivatives, an ML call
(another container, ONNX on all cores) and an integrity sweep can coincide;
each limit is local to its stage. Nothing sees the sum, which is the only
number the fan hears.

**P9 — Pacing is written five times and fails open** (ARC-03, C5, C8). Quiet
hours (E19) would have to be taught five times; a Postgres blip lifts every
limit at once — the opposite of what a thermal guard must do.

## 3. The strategy in seven principles

The state of the art for "reactive but gentle" background work is the same
everywhere it is done well (Kubernetes controllers, Syncthing's watcher plus
full rescan, Immich's library watch plus nightly scan, TCP congestion control,
Facebook's `senpai`/`oomd`): **cheap detection, expensive work shaped by a
budget, and the budget driven by measured pressure.**

1. **Detection and work are two problems.** Detection must be cheap and
   frequent (it decides reactivity); work must be shaped (it decides the fan).
   Today one walk does both, so speeding one up worsens the other.
2. **Events are hints, the reconcile is the truth.** An import, the inbox, a
   NAS-side notification say *where* to look, now. A periodic full reconcile,
   slow and off-peak, catches everything a hint missed. Neither is trusted
   alone.
3. **Two lanes.** *Interactive*: what a human is waiting for — the thumbnails
   of what just arrived, a Retry clicked now. Small, served first, allowed a
   burst. *Background*: proxies, ML, backfills, regenerations, the reconcile.
   Large, shaped, the first to yield.
4. **Budget work, not jobs.** Tokens are seconds of work (an estimate per job
   type and size, corrected by the measured duration once the job ends). A
   constant work budget is a constant average power — what keeps a fan steady.
5. **Close the loop on real pressure.** Read Linux PSI
   (`/proc/pressure/cpu`, `/proc/pressure/io`: host-wide, so the ML container,
   Postgres and the app all count) and the CPU package temperature
   (`/sys/class/thermal/thermal_zone*/temp`, `x86_pkg_temp`). An AIMD
   controller scales the background lane: halve on pressure or heat, add back
   slowly when calm. The box finds its own quiet speed instead of a number the
   maintainer guesses.
6. **Let the kernel enforce the floor.** Child processes at nice 15; a
   cgroup CPU cap (`cpus:`) on the worker as the hard thermal ceiling no bug
   can cross; the app keeps the default weight, so an open page always wins.
7. **Time matters, and failure is closed.** A night window with a bigger
   background budget (E19 is one branch of the same governor); a settings read
   that fails keeps the last known values, never "unlimited".

## 4. The design

### 4.1 Detection in three tiers (+ one optional)

- **T0 — explicit, seconds.** Import, upload and the inbox enqueue a scan of
  the *directories they wrote* (`{ rootId, dirs: [...] }`), lane interactive.
  The walk, the stat gate, the per-session reconciles (pairing, bursts) are
  the same code over a narrower start point. The missing-file reconcile runs
  for those directories only — it is already per-path (`visited`), it just has
  to be scoped to the dirs walked.
- **T1 — hot poll, every 1–2 min, O(directories).** Store each directory's
  mtime (sessions are directories: a `dir_mtime` beside `sessions.source_path`,
  plus the root's own subdirectory list). A tick `stat`s every known
  *directory* — a few thousand, not 100 000+ files — and only a directory whose
  mtime moved is `readdir`'d and its files run through the stat gate. A
  directory's mtime moves when an entry is added, removed or renamed in it, so
  new folders, new files, deletes and moves are seen within the tick plus the
  NFS attribute cache (`acdirmax`, 60 s). What it cannot see: a file rewritten
  in place (same name) — that is T2's job.
- **T2 — full reconcile, nightly.** Today's walk, unchanged in meaning, moved
  into the night window and made cheaper: one `SELECT abs_path, file_size,
  file_mtime FROM assets WHERE session_id = $1` per directory instead of two
  queries per file, sessions cached for the walk. It also refreshes T1's
  stored mtimes, so T1 can never drift for long.
- **T3 — optional NAS push.** A ~20-line `inotifywait` loop on the NAS itself
  (where inotify works) posting `POST /api/scan/hint { path }` with an app
  token. Pure bonus: T0–T2 are complete without it. It lives on the NAS, so it
  is the maintainer's call (§6, S5).

`rescanMinutes` becomes T1's interval; T2 gets its own schedule. Coalescing
stays per root, and a hint for a directory already in a pending job merges.

### 4.2 One governor: `pace(lane, stage, cost)`

ARC-03's seam, grown to carry the policy (`lib/rate.ts`):

- **Two buckets of work-seconds**, interactive and background, each with a
  rate and a burst. Interactive: e.g. 600 s of work per hour with a 300 s
  burst — a 200-photo card is thumbnailed at once, a second card in the same
  minute waits its turn. Background: whatever is left of the box's budget.
- **Cost per job**, estimated before (a table: preview JPEG 0.3 s, .hif 3 s,
  DNG demosaic 10 s, video poster 5 s, video proxy ≈ `duration_s` × a factor
  measured once per encoder) and **charged after** with the real elapsed time,
  so a wrong estimate costs one job, not a backfill.
- **Feedback multiplier** `m ∈ [0.1, 1]` on the background rate, recomputed
  every 10 s: PSI `some avg10` above a threshold (cpu ~25 %, io ~40 %) or the
  package above a target temperature → `m × 0.5`; otherwise `m + 0.05`. The
  interactive lane has a floor and is only scaled under severe pressure. If
  PSI or the thermal zone is unreadable, `os.loadavg()[0] / cores` is the
  fallback signal — and the page says which one it uses.
- **Quiet hours**: the background rate is a function of the clock (a day and
  a night value, E19); the interactive lane is not.
- **Waiting releases the slot**: every queue waits through `rateLimit()` / a
  delayed re-queue (C5), except the scan walk, which paces itself per heavy
  file because it cannot hand a half-walk back to the queue.
- **Fail closed** (C8): the last values read stay in force on a DB error.
- **Visible**: Settings › Pipeline shows the signal (`cpu 12 %, io 3 %, 61 °C`),
  the multiplier (`background at 60 %`) and each lane's backlog in minutes of
  work. A governor nobody can read is a mystery slowdown.

The lane is decided at enqueue, not guessed later: incoming / import / a
human click → interactive; regenerate-all, backfills, the reconcile's
discoveries in old folders, ML → background.

### 4.3 Split the expensive derivative

- **Video poster first, proxy later.** The derivative job writes the poster
  and `thumb_key` and marks the clip visible (interactive lane); the proxy is
  its own job (`derive-proxy`, background lane). The grid shows a new clip in
  seconds; the transcode drips. The viewer must then show the poster, not an
  error, while the proxy is pending — to check when it lands. Whether "pending proxy" needs its own status column is
  a migration (next free number `0057`) — §6, S2.
- **Bounded encoder threads**: `-threads N` on the transcode (`VIDEO_THREADS`,
  default 2), and VAAPI on where the iGPU is present — Quick Sync encodes a
  4K clip at a fraction of the package power libx264 needs.
- **ML stays chained after the derivative**, in the background lane.

### 4.4 OS guardrails (compose and image, no new dependency)

- `os.setPriority(child.pid, 15)` on every spawned child (ffmpeg, `dcraw_emu`,
  the HEIF child). exiftool-vendored's pool is long-lived: start it under
  `nice` via its `exiftoolPath` wrapper, or accept nice 0 for 128 KiB reads.
- Worker `cpus: "<n>"` in `docker-compose-optiplex.yml`: a hard ceiling under
  the core count. It bounds the worst case whatever the code does — the one
  guard that survives a bug in the governor.
- The immich-ml container lives in Immich's own stack: its request and ONNX
  thread counts (Immich's `MACHINE_LEARNING_*_THREADS` variables — check the
  names against the pinned Immich version) and a `cpus:` there are the
  operator's lever, documented, not shipped by this repo.

### 4.5 Targets the design is held to

| Event | Target |
|---|---|
| A file written by import / upload / inbox | indexed < 10 s after the copy, photo thumbnail < 30 s, video poster < 60 s |
| A file copied straight onto the NAS | seen < 2 min (T1) |
| A file rewritten in place | seen by the next night (T2), or at once with T3 |
| A 2 000-file card while a page is open | no page slower than at rest; fan never at full |
| Background backlog (regenerate, ML backfill) | drains at the box's quiet speed, faster at night, never a peak |

## 5. Phased plan — one pull request each

**Phase 0 — measure first (no behaviour change).** Read PSI, the thermal zone
and loadavg in the worker, publish them to Redis every 10 s, show them on
Settings › Pipeline; record each derivative's elapsed time and media type in
the job's return value. The local session of §8.2 answers the questions
first, from the host — is PSI readable in the container, which zone is the
package, what a .hif / a clip really costs; the panel keeps them visible
afterwards, without a terminal. Every number in §4.2 is a placeholder until
this runs.

**Phase 1 — quick wins, low risk.** (a) video poster split from the proxy;
(b) `-threads` + nice on children; (c) one query per directory in the walk;
(d) import / inbox scan only the directories they wrote; (e) compose `cpus:`
on the worker (value from phase 0). Each is small and independently
revertible; together they remove the worst peak (P2) and most of P5–P6.

**Phase 2 — the governor.** `pace()` with two lanes, work-second buckets,
fail-closed settings, every site on `rateLimit()` (ARC-03, C5, C8 closed
together); lanes assigned at every enqueue site listed in P7. Tests on
`pace()`: paused, under budget, over budget, burst, the fallback signal.

**Phase 3 — detection tiers.** `dir_mtime` (migration), the T1 hot poll, T2
moved to the night window with its own schedule, `POST /api/scan/hint`.
Verified through the real `indexRoot` on a temp tree: add, delete, rename a
file and a folder, each seen by T1; an in-place rewrite seen only by T2.

**Phase 4 — the closed loop and quiet hours.** The AIMD multiplier on PSI and
temperature, the day/night window (E19) and its controls. Last on purpose: it
tunes a system phases 0–3 made measurable.

## 6. Decisions for the maintainer

- **S1 — The thermal ceiling.** A hard `cpus:` on the worker (and on
  immich-ml) makes the worst case quiet and every backlog slower. What share
  of the box may Winnow ever take?
- **S2 — Video proxy as a second job.** The grid gets the poster at once; the
  proxy arrives later and a clip can be "visible, not yet playable" for a
  while. Accept that state, and with it a status column (migration `0057`)?
- **S3 — The full reconcile's cadence.** Nightly is the proposal. An in-place
  rewrite (an external tool writing GPS into a file) would then wait for the
  night unless the NAS agent (S5) is installed.
- **S4 — The quiet window.** Which hours are "go as fast as you like", and
  does the window also hold back the interactive lane (no, by default)?
- **S5 — The NAS agent.** Something running on the NAS is outside this repo
  and outside "Winnow touches the originals once". Wanted, or T1 is enough?
- **S6 — The control signal.** PSI alone measures contention (the app slows);
  temperature measures noise (the fan). Both is the proposal; temperature
  needs a target the maintainer chooses with the box in the room.

## 7. What not to do

- **A watcher on the NFS mounts** (chokidar, inotify, `usePolling` over
  100 000+ files): inotify does not cross NFS, and polling every file is the
  full walk again, every few seconds. The directory-mtime poll is the
  polling that scales.
- **Raising `SCAN_CONCURRENCY` or walking in parallel**: the NAS is one
  spinning disk; parallel walks seek against each other.
- **BullMQ's queue `limiter` as the policy**: it counts jobs, P3's flaw. It
  is a fine *mechanism* for the governor to drive, not a substitute for one.
- **A lower number everywhere**: it trades the fan for the reactivity the
  maintainer asked to keep. Lanes exist so the two stop competing.
- **`ionice` as the NAS's protection**: it schedules the Optiplex's own disk;
  the NAS's HDD only sees the rate.
- **Hashing more of each file to detect in-place edits**: the stat gate is
  what keeps a reconcile free (`docs/memory/pipeline.md`); size + mtime stay
  the change signal.

## 8. Running it: a local Claude Code session on the Optiplex

The maintainer will carry this plan out himself, from `claude` (the CLI) on
the Optiplex. That changes how it starts, not what ships: a local session can
read the host's pressure, temperatures and containers directly, so phase 0's
numbers come from the machine before any code is written. Everything the plan
delivers still lands as UI (the governor's readings on Settings › Pipeline,
the controls for S1–S6): the CLI is how the work is done and measured, not a
channel the instance depends on (`MEMORY.md`, "A repair the maintainer has to
SSH into… does not exist").

### 8.1 Before the first phase

- A checkout of this repository on the Optiplex (`git clone`, then
  `npm ci`), separate from the running stack, which keeps pulling the ghcr
  image. Nothing in the plan runs the dev server against the production
  database.
- The CLAUDE.md rules for a **local** session apply: one commit per phase
  (or per item of phase 1), the full gate green before each (`npm run lint`,
  `typecheck`, `test`, plus `migrate` when a migration lands and `build`),
  memory updated in the same commit, the Registry block after a `Registry:`
  line in the commit body — and **never `git push`**: the maintainer reviews
  and pushes.
- §6's decisions answered, or at least S1 (the share of the box) and S2 (the
  video proxy as a second job): phase 1 depends on both.

### 8.2 Phase 0 on the machine: what to measure, read-only

Each line reads; none changes the stack. The session records the answers in
§9 below (a new section, dated) so the numbers outlive the session.

| Question | Command (host) |
|---|---|
| CPU, cores | `nproc; lscpu \| grep 'Model name'` |
| PSI readable on the host | `cat /proc/pressure/cpu /proc/pressure/io` |
| PSI readable **inside** the worker | `docker exec winnow_worker cat /proc/pressure/cpu` |
| Which thermal zone is the package | `for z in /sys/class/thermal/thermal_zone*; do echo "$(cat $z/type) $(cat $z/temp)"; done` |
| Readable inside the worker too | `docker exec winnow_worker sh -c 'cat /sys/class/thermal/thermal_zone*/type'` |
| Fan speed, if exposed | `sensors` (lm-sensors), else the zones above |
| Is VAAPI on, and does it work | `docker exec winnow_worker printenv VIDEO_HWACCEL DERIVATIVE_CONCURRENCY SCAN_CONCURRENCY`, then `docker exec winnow_worker vainfo` |
| The live rates | Settings › Pipeline, or `docker exec winnow_postgres psql -U winnow -c "SELECT key, value FROM app_settings"` (container and user names from `docker ps` / `.env`) |
| Is the worker throttled by a cap | `docker inspect winnow_worker --format '{{.HostConfig.NanoCpus}}'` (0 = no cap) |
| Who burns during a peak | `docker stats --no-stream` and `top -o %CPU -b -n1 \| head -20` while a card is being derived |

Then three short recordings, each sampling every 10 s
(`/proc/pressure/cpu`, `/proc/pressure/io`, the package zone, `docker stats
--no-stream`) into a CSV under the session's scratch directory:

1. **At rest**, 10 min: the floor.
2. **During an hourly rescan** (Settings › Pipeline, re-index the incoming
   root): the cost of P5 on its own.
3. **During a real import** of a few hundred files with clips in it: the peak
   P1–P2 describe. Note the time from the end of the copy to the first
   thumbnail and to the first video poster — the §4.5 targets start from
   those two numbers.

What the session reports at the end of phase 0: the three recordings
summarised (mean / p95 of `some avg10`, max temperature), whether PSI and the
package zone are readable in the container (if not, the governor's fallback
signal is the plan), whether VAAPI works, and the measured cost of a JPEG
preview, a .hif and a one-minute clip. Those replace the placeholders in §4.2.

### 8.3 Then, one phase at a time

Phases 1 → 4 of §5, in order, each closed by its commit, its tests and, for
phase 1, the same recording as 8.2 step 3 repeated: the plan works when the
peak's p95 and the maximum temperature fall while the two reaction times do
not grow. A phase whose recording does not improve stops the plan there, and
the finding goes into §9 before anything else is built.

### 8.4 The prompt to start with

```
Read CLAUDE.md, MEMORY.md, docs/memory/pipeline.md and docs/SCAN-PACING.md.
We are on the Optiplex that runs Winnow; this is a local session (never push).
Run phase 0 as §8.2 describes: read-only measurements on the host and in the
winnow_worker container, the three recordings, then write the results into a
new dated §9 of docs/SCAN-PACING.md and replace the placeholders of §4.2
where a measurement answers them. Ask me before anything that changes the
running stack. Then stop and summarise; we will decide phase 1 together.
```
