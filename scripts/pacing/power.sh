#!/usr/bin/env bash
# CPU power policy: save / set / restore. Needs root for set and restore.
#   power.sh save            -> $PACING_DIR/exp/power-backup.txt (EPP of every CPU + no_turbo), never overwritten
#   power.sh set EPP [TURBO] -> EPP on every CPU (balance_performance|balance_power|power), TURBO 1=on 0=off
#   power.sh restore         -> writes back exactly what save recorded
#   power.sh show
# Nothing here is persistent: a reboot also brings the defaults back.
set -eu
B=${PACING_DIR:-$HOME/winnow-pacing}/exp/power-backup.txt; mkdir -p "$(dirname "$B")"
C=/sys/devices/system/cpu
case $1 in
  save)  [ -e "$B" ] && { echo "backup exists, kept: $B"; exit 0; }
         { for f in $C/cpu[0-9]*/cpufreq/energy_performance_preference; do echo "$f $(cat $f)"; done
           echo "$C/intel_pstate/no_turbo $(cat $C/intel_pstate/no_turbo)"; } > "$B"; echo "saved $(wc -l < $B) values to $B" ;;
  set)   [ -e "$B" ] || { echo "run save first"; exit 1; }
         for f in $C/cpu[0-9]*/cpufreq/energy_performance_preference; do echo "$2" > $f; done
         echo $(( 1 - ${3:-1} )) > $C/intel_pstate/no_turbo ;;
  restore) while read -r f v; do echo "$v" > "$f"; done < "$B"; echo restored ;;
  show)  echo "EPP: $(cat $C/cpu*/cpufreq/energy_performance_preference | sort | uniq -c | xargs)  no_turbo=$(cat $C/intel_pstate/no_turbo)" ;;
esac
