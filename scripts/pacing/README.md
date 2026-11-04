# Pacing measurements — phase 0 tools

The scripts that produced the numbers in `docs/SCAN-PACING.md` §9, run on the
Optiplex from a local session. They live here because §8.3 asks for the same
recording again after each phase: a phase whose recording does not improve
stops the plan. None of them is part of the app, the image or CI.

Data goes to `$PACING_DIR` (default `~/winnow-pacing`), never into the
checkout. Container names are the instance's (`winnow-worker`,
`winnow-redis`, `winnow-postgres`, hyphens).

| Script | What it does | Changes anything? |
|---|---|---|
| `record.sh LABEL SECONDS` | one sample every 10 s → `LABEL.csv` (host + worker-cgroup PSI, package °C, fan rpm, load, host CPU %, worker CPU µs, RAPL µJ, throttle count) and `LABEL-docker.csv` (`docker stats` per container). Appends to an existing label. | no (RAPL needs `sudo -n`, left empty without it) |
| `summarise.py LABEL…` | mean / p95 / max of a recording, worker cores, package watts, throttle events, top containers | no |
| `jobs.sh EPOCH_MS [queue]` | BullMQ timings per job (`processedOn → finishedOn`, wait) from Redis | no |
| `reaction.sh T0 [COPY_END]` | reaction delays of an import: assets indexed since T0, their derivative jobs, delay from the end of the copy | no |
| `power.sh save\|set\|restore\|show` | the host's CPU power policy: EPP on every CPU and `intel_pstate/no_turbo` | **yes, root** — `save` first (never overwritten), `restore` puts back exactly what was saved; nothing is persistent across a reboot |
| `exp.sh` | the EPP / turbo experiment of §9.3: for each condition in `CONDS` and each load in `LOADS`, wait for a calm box, run the load in a throwaway container of the worker image (`--rm`, no network, outputs on a tmpfs), log `cond,turbo,load,start,end,secs,exit` to `exp/runs.csv`. Restores the policy on any exit. | **yes, through `power.sh`** |
| `exp-analyse.py LABEL` | per-run duration, net package energy, peak watts, package temperature, throttle events, fan peak and recovery | no |

## Running the experiment

```bash
export PACING_DIR=~/winnow-pacing
mkdir -p $PACING_DIR/exp/in      # copy a few .HIF and a clip.mp4 here (local copies, not the NAS)
sudo env PACING_DIR=$PACING_DIR scripts/pacing/power.sh save
# detached: an SSH drop sends SIGHUP to a foreground run and kills it
sudo systemd-run --unit=winnow-exp --uid=$USER --gid=$USER \
  --working-directory=$PWD --setenv=HOME=$HOME --setenv=PACING_DIR=$PACING_DIR \
  --setenv=CONDS="balance_performance:1 balance_performance:0" --setenv=LOADS="hif clip" \
  -p StandardOutput=append:$PACING_DIR/exp/exp.log -p StandardError=append:$PACING_DIR/exp/exp.log \
  $PWD/scripts/pacing/exp.sh
python3 -I scripts/pacing/exp-analyse.py exp-$(date +%m%d)
```

Two traps met on 2026-11-04:

- **Run it detached.** The first run was killed by an SSH drop after nine of
  ten runs (the trap restored the policy, the tenth was re-run alone).
- **`sudo -n` is needed for `power.sh` and the RAPL read.** Never grant it
  as `NOPASSWD: ALL`, and never as a rule naming a script in this checkout,
  which the user can rewrite: a narrow rule names a root-owned copy
  (`/usr/local/sbin/`), and is removed when the measurements end.
