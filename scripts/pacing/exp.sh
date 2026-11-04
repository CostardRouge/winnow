#!/usr/bin/env bash
# EPP / turbo experiment. Same code as the worker, in a throwaway container
# (--rm, no network, outputs on a tmpfs), on local copies of the inputs.
# Restores the saved power policy on ANY exit (end, error, Ctrl-C, kill).
set -u
S=$(cd "$(dirname "$(readlink -f "$0")")" && pwd); D=${PACING_DIR:-$HOME/winnow-pacing}; E=$D/exp; IMG=ghcr.io/costardrouge/winnow:main
LABEL=${LABEL:-exp-$(date +%m%d)}; LOG=$E/runs.csv
CONDS=${CONDS:-"balance_performance:1 balance_power:1 power:1 balance_performance:0 balance_performance:1"}
LOADS=${LOADS:-"hif clip"}
restore(){ sudo -n env PACING_DIR=$D $S/power.sh restore; $S/power.sh show; kill $REC 2>/dev/null; }
trap restore EXIT; trap 'exit 130' INT TERM
[ -e $E/power-backup.txt ] || { echo "no backup: run power.sh save first"; exit 1; }
last(){ tail -1 $D/$LABEL.csv | cut -d, -f$1; }
calm(){ # fan on its floor for 30 s, >= 120 s after the last run, Winnow idle, not in an hourly walk; max 15 min
  local t0=$(date +%s) ok=0
  while [ $(( $(date +%s) - t0 )) -lt 900 ]; do
    m=$(( 10#$(date +%M) )); busy=$(docker exec winnow-redis sh -c 'echo $(( $(redis-cli LLEN bull:winnow-derivatives:active) + $(redis-cli LLEN bull:winnow-index:active) + $(redis-cli LLEN bull:winnow-ml:active) ))')
    if [ "$(last 11)" -lt 1900 ] && [ $(( $(date +%s) - t0 )) -ge 120 ] && [ "$busy" = 0 ] && { [ $m -lt 4 ] || [ $m -gt 8 ]; }; then ok=$((ok+1)); else ok=0; fi
    [ $ok -ge 3 ] && return 0; sleep 10
  done; echo "calm timeout, going on" >&2
}
load(){ local base=(docker run --rm --network none --tmpfs /out:size=2g -v $E/in:/in:ro $IMG)
  case $1 in
    hif)  "${base[@]}" sh -c 'for p in 1 2; do for f in /in/*.HIF; do node --import tsx src/scripts/heicDecode.ts "$f" /out/x.jpg 1 || exit 1; done; done' ;;
    clip) "${base[@]}" sh -c 'ffmpeg -hide_banner -loglevel error -y -i /in/clip.mp4 -vf thumbnail=n=50 -frames:v 1 -an /out/p.webp && ffmpeg -hide_banner -loglevel error -y -i /in/clip.mp4 -vf "scale=-2:min(720\,trunc(ih/2)*2)" -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart /out/p.mp4' ;;
  esac; }
PACING_DIR=$D $S/record.sh $LABEL 14400 > $E/rec.log 2>&1 & REC=$!
sleep 25
[ -e $LOG ] || echo "cond,turbo,load,start,end,secs,exit" > $LOG
for c in $CONDS; do epp=${c%:*}; tb=${c#*:}
  sudo -n env PACING_DIR=$D $S/power.sh set $epp $tb || exit 1
  for l in $LOADS; do calm; s=$(date +%s); load $l > $E/last.err 2>&1; rc=$?; e=$(date +%s)
    echo "$epp,$tb,$l,$s,$e,$((e-s)),$rc" | tee -a $LOG; done
done
calm   # record the last cool-down before restoring
