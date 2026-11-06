# Scan pacing — reactive without the fan

*Written 2026-10-30 as a brief, **nothing built yet**. The maintainer's ask:
"organise how files are scanned so it is very reactive, and orchestrate it
better: sometimes the machine blows hard — there are probably better
strategies to scan gently, over time, while staying reactive, rather than load
peaks and the fan climbing for a while". §2 says why the box peaks today, read
from the code; §3–§4 are the strategy; §5 orders it into pull requests; §6 is
what only the maintainer can decide; §8 is how he runs it, from a local
Claude Code session on the Optiplex; §9 is what phase 0 measured there
(2026-11-01, 2026-11-04). It builds on two findings already filed
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
  a migration (next free number `0059`; `0058` went to `favourites`) — §6, S2.
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
this runs — measured since: §9.4.

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
  while. Accept that state, and with it a status column (migration `0059`)?
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

- The box holds the **stack, not the repository**: the session starts in
  the compose directory, where the containers are, and the code is a fresh
  `git clone` beside it (read-only for phase 0; `npm ci` there from phase 1).
  The running stack keeps pulling the ghcr image; nothing in the plan runs
  the dev server against the production database.
- The homelab moves on its own (security and performance passes the
  repository does not record), so the session **checks before it assumes**:
  a CPU cap already set, VAAPI already on, a renamed container are findings
  for §9, not errors.
- Credentials the maintainer leaves on the box for the session (sudo, the
  Portainer API) are read from files by redirection and **never printed** —
  not into the transcript, not into a report — and the session reminds him
  to delete them at the end. A command whose output would carry a secret
  (`docker inspect`, a container's environment, `.env`) is filtered to the
  keys it needs.
- Phase 0's report is written beside the stack and handed back to the cloud
  session that holds this plan, which writes it in as §9 and pushes: a local
  session never pushes, and the box has no checkout to commit from anyway.
- The CLAUDE.md rules for a **local** session apply: one commit per phase
  (or per item of phase 1), the full gate green before each (`npm run lint`,
  `typecheck`, `test`, plus `migrate` when a migration lands and `build`),
  memory updated in the same commit, the Registry block after a `Registry:`
  line in the commit body — and **never `git push`**: the maintainer reviews
  and pushes.
- §6's decisions answered, or at least S1 (the share of the box) and S2 (the
  video proxy as a second job): phase 1 depends on both.

### 8.2 Phase 0 on the machine: what to measure, read-only

Each line reads; none changes the stack. The answers end up in §9 below (a
new section, dated) so the numbers outlive the session.

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

The generic form; the maintainer's own copy adds where his credentials
are and which cloud session to hand the report to (kept out of this public
file).

```
You are on the Optiplex, in the compose directory of the Winnow stack (no
repository here). Clone github.com/CostardRouge/winnow beside it and read
CLAUDE.md, MEMORY.md, docs/memory/pipeline.md and docs/SCAN-PACING.md.
This is a local session: never push. Check the stack before assuming
anything the repository says about it. Run phase 0 as §8.2 describes:
read-only measurements on the host and in the worker container, the three
recordings, then write a report (findings, results, the numbers that
replace §4.2's placeholders) beside the stack. Never print a credential.
Ask me before anything that changes the running stack. Then stop and
summarise; we will decide phase 1 together.
```

## 9. Phase 0 results (2026-11-01, 2026-11-04)

*Measured on the Optiplex by two local sessions, as §8.2 describes: read-only
on 2026-11-01 (image `4b0f174`) and 2026-11-04 (image `ef4c991`), plus one
hour on 11-04 afternoon that changed the host's CPU power policy and restored
it (§9.3). The two full reports, with the host's inventory, stay in the
maintainer's private infrastructure notes; the raw 10 s recordings stay on the
box. The tools are `scripts/pacing/` (its README says how to run them again,
which §8.3 needs after each phase). No import happened in either window: the
import recording and the reaction delays (§8.2 step 3) are still owed (§9.7).*

### 9.1 What the box offers the governor

| Signal | Readable in the worker? | What it is worth (§9.5) |
|---|---|---|
| Host PSI `/proc/pressure/{cpu,io}` | yes (the host's counters) | contention only, blind to heat |
| Worker cgroup `cpu.pressure` (`/sys/fs/cgroup`) | yes | tells the worker's own contention (three ffmpeg) from the box's |
| Package temperature, `thermal_zone4` = `x86_pkg_temp` | yes | jumps to the ceiling in 10 s, rest level drifts 48–82 °C over a day: too coarse for a target |
| Fan, `dell_smm` hwmon `fan1_input` | yes | the noise itself; lags the load ~30 s and takes up to 7 min to come down. Reads above the driver's 4 000 rpm maximum under load (5 928 seen): trust its steps, not its value above ~4 000 |
| `thermal_throttle/package_throttle_count` | yes | 0 at rest and during the rescan, +1 400–2 100/min at the ceiling: a clean "over the ceiling" signal |
| RAPL package energy | **no, root only** | the best proportional signal; usable from the host only |

The box: i7-12700 (12 C / 20 T), `intel_pstate` with EPP `balance_performance`
and turbo on (P-cores to 4.8 GHz), RAPL PL1 65 W / PL2 202 W. The worker has
no CPU cap (`NanoCpus 0`), `DERIVATIVE_CONCURRENCY=3`, and **every rate is 0
on the instance, `ml_per_hour` included** (P1 is worse than written: nothing
is paced).

### 9.2 Recordings

10 s samples; PSI is `some avg10` in %, mean / p95 / max; worker in cores;
package power from RAPL on the host.

| What | CPU PSI | Package °C | Fan rpm | Host CPU % | Worker | Package W | Throttle events |
|---|---|---|---|---|---|---|---|
| Rest (11-04 noon / afternoon) | 0.0 / 0.0 / 0.4 | 55 / 67.5 mean | ~1 800 | ~5 | 0.02 | 11–15 | 0 |
| Hourly rescan, the walk (100 593 + 7 808 files in 54 + 10 s; 82–94 s on 11-01) | ≤ 0.1 | ≤ 75 | flat | ~8 | 0.3 (+ Postgres 0.3) | ~20 | 0 |
| One 4K clip alone (DJI, 59 s) | ≤ 1.8 | 88 within 10 s, 100 from +30 s | → 2 659 | ~31 | 5.3 | 69 | +6 319 |
| 55 Sony `.hif` (folder re-derive, concurrency 3) | 0.4 / 2.0 / 5.6 | 90 / 100 / 100 | → 3 873 | ~10 | 1.2 | 45 | +5 481 |
| 26 Sony clips (21 × 4K, concurrency 3) | **36 / 52 / 54** | 94 / 100 / 100 | → 5 928\* | **90** | **16.9** | 68 | +20 033 |

\* above the driver's 4 000 rpm, see §9.1. During the `.hif` run Immich ML
peaked at 10.5 cores in its own container (no thread limit set), and the
fan needed 7 min 10 s after the clip run to fall back under 1 900 rpm.

### 9.3 The CPU power policy experiment (2026-11-04, 16:17–17:13 UTC)

§6 S1's question, asked to the host. The worker image's own code, in a
throwaway container on local copies of the inputs (no NFS, no queue):
**hif** = 20 sequential decodes of 10 Sony `.hif` by `heicDecode.ts` (one
core); **clip** = the DJI 4K clip's poster + 720p libx264 proxy, the
worker's two ffmpeg passes (~5 cores). Five conditions, a calm box (fan on its
floor for 30 s, ≥ 120 s after the last run, Winnow's queues idle) before each
run, the reference repeated last as a control. Net energy = RAPL package
energy over the run minus the pre-run baseline (8–11 W).

| Policy | hif time | hif energy · peak W · max °C | clip time | clip energy · peak W · max °C · throttle | clip fan peak |
|---|---|---|---|---|---|
| `balance_performance` + turbo (ref; control) | **77 s; 77 s** | 2.15 kJ · 41 W · 89 °C | **86 s; 86 s** | 5.0–5.1 kJ · 80–82 W · 100 °C · ~6 200 | 3 191 |
| `balance_power` + turbo | 81 s (+5 %) | 2.30 kJ · 41 W · 97 °C | 88 s (+2 %) | 4.9 kJ · 79 W · 100 °C · 6 507 | 3 045 |
| `power` + turbo | 94 s (+22 %) | 2.09 kJ · 35 W · 92 °C | 103 s (+20 %) | 4.7 kJ · 66 W · 97 °C · 2 639 | 3 019 |
| `balance_performance`, **turbo off** | 167 s (× 2.2) | **0.61 kJ · 13 W · 61 °C** | 159 s (× 1.85) | **1.7 kJ · 20 W · 62 °C · 0** | **2 652** |

The controls match the reference to the second, and the clip's 86 s equals
§9.4's measurement inside the worker.

1. **EPP barely matters.** `balance_power` is indistinguishable from the
   reference; `power` trims the peak by 15–18 % and halves throttling, but
   the package still reaches 97 °C — for +20 % of time. Under HWP, EPP nudges
   how fast a core ramps; it does not cap the turbo frequency.
2. **Turbo is the lever.** Without it neither load passed 62 °C, nothing
   throttled, and each job cost 66–72 % less energy for 1.85–2.2 × the time.
   One busy core costs +4.6 W over rest without turbo, +30 W with it.
3. **The fan does not follow the package alone.** On the clip without turbo
   the package stayed at 54–62 °C and the fan still rose 1 817 → 2 652 rpm,
   30 s in. The BIOS curve reads other sensors too. The host's Prometheus
   keeps the Dell board sensors (node-exporter's hwmon, 30 s): at that same
   +30 s the board's **"Ambient"** sensor jumped 70 → 76 °C and the second
   NVMe (the clip's local copy being read) 47 → 52 °C, while the board's
   "CPU" sensor moved 55 → 56 °C. "Ambient" rises on every clip run (+3 to
   +8 °C) and not on the `.hif` runs: the best candidate for what the fan
   follows, from one run at 30 s resolution. Five busy cores at ~20 W were
   audible; the hourly rescan at ~20 W on fewer cores was not.
4. **One decode alone does not reach the ceiling.** 77 s of one `.hif` decoder
   at turbo peaked at 89 °C without throttling. The noon run that reached
   100 °C lasted 225 s with Immich ML bursting to 10 cores beside it.
5. **Turbo is host-wide.** Neither the worker nor a container can scope it;
   turning it off slows every neighbour on the box. Untested middle grounds:
   `intel_pstate/max_perf_pct` 60–70 % with turbo on, and RAPL PL1 at 25–35 W.

### 9.4 Cost per derivative — the numbers for §4.2

BullMQ `processedOn → finishedOn`; "alone" = nothing else in the derivative
queue.

| §4.2 placeholder | Measured | Proposal |
|---|---|---|
| preview JPEG 0.3 s | JPEG 0.72 s, ARW 0.82 s alone (ARW median 0.64 s in history) | `photo_preview` **0.8 s** |
| `.hif` 3 s | 4.4–5.0 s alone, 3.9 s isolated (§9.3), 4.1 s of throughput in a batch: the decoding child is serialized, so concurrency 3 waits on one decoder | **4.5 s**, and the HEIF child is a lane of 1 |
| DNG demosaic 10 s | none in either sample | keep 10 s |
| video poster 5 s | not separable (poster and proxy are one job); short clips show a fixed ~8–10 s per clip | measure after phase 1 (a) |
| video proxy ≈ `duration_s` × factor | 4K libx264 alone **1.41–1.45 ×**; at concurrency 3 median 2.8 ×; Sony 1080p ~1.0 ×; iPhone 1080p 0.05–0.3 ×; turbo off 2.7 × (4K) | **10 s + 1.45 × duration** for 4K, 10 s + 1.0 × for Sony 1080p; by bitrate (`file_size / duration`) rather than height if available |
| ML per asset | 0.47–0.62 s warm, p90 0.93 s, 3.4 s after an idle spell (models reload) | **0.7 s**, background lane, counted in the box budget (P8) |
| PSI cpu ~25 % | rest ≤ 0.1, rescan ≤ 0.2, `.hif` ≤ 6, one clip ≤ 2, three clips 36 mean / 52 p95 | 25 % only sees saturation: keep it as the **contention** brake, read the worker's cgroup PSI for self-contention |
| PSI io ~40 % | ≤ 5 % in every recording | stands; IO is not this box's constraint |
| target temperature | rest 48–82 °C depending on the hour; work at 88–100 °C within 10–30 s | **no temperature target**: brake on throttle-count rate > 0 over 30 s (over the ceiling) and on `fan1_input` above its floor (noise); ease off when both are calm |
| (new) package power | rest 11–15 W, rescan 20 W, one `.hif` decoder 35–41 W at turbo / 13 W without, one clip 66–82 W / 20 W | the thermal budget is power, and turbo sets most of it (§9.3) |

**Poster delay today (P2, measured):** a 5-minute 4K clip had no grid
thumbnail for **424 s** after its job started, and the job started 2 min
after the batch was queued.

### 9.5 Departures from the plan

1. **The ceiling is reached by work that never saturates the box.** The
   `.hif` batch held the worker at 1.2 cores with the host at 10 % CPU and
   still put the package at 100 °C; one clip did it at 5 cores. A `cpus:` cap
   (§4.4, S1) bounds the 17-core clip folder, not those. Frequency and power
   are the lever (§9.3), and they are host settings, outside this repo.
2. **PSI is blind to heat** (≤ 6 % at 100 °C). It rises only when three clips
   saturate the box. S6's "both" stands, but the thermal half cannot be PSI.
3. **The package temperature is not a proportional signal** (§9.1), and the
   rest level drifts with the hour at the same 11–15 W: a fixed temperature
   target would mean different things at different times. The throttle rate
   does not drift.
4. **The fan is its own signal** (§9.3 point 3): it can rise with the package
   cool and nothing throttling, so the governor reads `fan1_input` directly.
5. **A capped container raises host PSI** (11-01: a 2-CPU-capped CI runner
   took host CPU PSI to 20 % with the box 88 % idle). With a `cpus:` on the
   worker, an AIMD loop on host PSI would brake on its own cap: read the
   worker's cgroup `cpu.pressure` for "am I throttled".
6. **Three clips contend with each other** (worker cgroup PSI 34 / 51 / 53 %).
   `-threads N` (§4.3) removes that; it does not remove one clip's heat.
7. **Nothing is paced on the instance**, ML included (`ml_per_hour = 0`), and
   Immich ML has no thread limit (~10 cores on `.hif`): P8 is real, and the
   ML container's threads are the operator's lever (§4.4).
8. **VAAPI is not one env flip away.** The image's `i965` driver cannot drive
   this Gen12 iGPU (`vainfo`: `iHD_drv_video.so` absent, `i965` init fails);
   `intel-media-va-driver(-non-free)` must go into the Dockerfile first.
   ffmpeg is 7.1 since the Debian 13 image and may decode HEIF natively
   (untested).
9. **P5 is small.** The hourly walk costs ~1 min at ~0.6 core (worker +
   Postgres), no CPU pressure, ≤ 5 % IO, no fan change. It costs
   reactivity (P6), not noise: phase 1 (c) is a nice-to-have.
10. **§8.2's commands name `winnow_worker` / `winnow_postgres`**; the
    instance's containers are `winnow-worker`, `winnow-app`,
    `winnow-postgres`, `winnow-redis`, in a Portainer stack (no compose
    directory to `cd` into). The production stack runs **no `backup`
    sidecar**; the host's own nightly dump covers Postgres.
11. **A session's Regenerate on a folder of 74 `.hif` + 74 `.arw` enqueued 55
    jobs, all `.hif`.** Not investigated: by design (pairs) or a gap in what a
    session regenerate selects.

### 9.6 What it says about §6

- **S1 — the thermal ceiling.** The share of the box that stays quiet is a
  share of **power**, set mostly by turbo. A worker `cpus:` is still worth it
  as the guard against a 17-core clip folder, not as the noise fix. The
  noise fix measured is host-side (turbo off: silent `.hif`, cool clips, ×2
  time, the whole box slower); `max_perf_pct` and PL1 are the next tests.
  The maintainer's call, and none of it ships from this repo.
- **S2 — proxy as a second job.** The measured cost of not doing it: a
  5-minute clip invisible for 7 minutes after its job starts. A clip is also
  the heaviest thermal event: as a background job it can wait for the night
  (S4) or for a calm fan.
- **S6 — the control signal.** Host PSI for "the box is busy", the worker's
  cgroup PSI for its own contention, the throttle-count rate for "over the
  ceiling", `fan1_input` for the noise. No temperature target.
- S3, S4, S5: nothing measured changes them.

### 9.7 Still owed

- **An import recording** with reaction delays (`record.sh import 7200`
  during a real card, then `reaction.sh <copy start> <copy end>`): time to
  first thumbnail and first video poster, §4.5's starting point.
- Which sensor the BIOS fan curve follows: "Ambient" is the candidate
  (§9.3 point 3); a load that heats the board without the CPU (a long local
  disk read) would confirm it. Not readable today from inside the worker
  except through the same hwmon files (`dell_smm`, `temp2`).
- `max_perf_pct` and PL1 as `exp.sh` conditions (`power.sh` needs a `set`
  branch for each).
- A DNG demosaic, and the poster alone once phase 1 (a) splits it.
