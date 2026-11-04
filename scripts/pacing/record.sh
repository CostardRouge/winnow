#!/usr/bin/env bash
# Read-only phase-0 recorder: one sample every 10 s.
# usage: record.sh LABEL SECONDS   -> $PACING_DIR/LABEL.csv + LABEL-docker.csv (default ~/winnow-pacing)
# Appends to an existing LABEL: a restart never truncates a recording already made.
set -u
label=$1; dur=$2; dir=${PACING_DIR:-$HOME/winnow-pacing}; mkdir -p "$dir"
out=$dir/$label.csv; dout=$dir/$label-docker.csv
pkg=/sys/class/thermal/thermal_zone4/temp   # x86_pkg_temp (checked 2026-11-01)
fan=$(for h in /sys/class/hwmon/hwmon*; do [ "$(cat $h/name)" = dell_smm ] && echo $h/fan1_input; done)
wcg=/sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' winnow-worker).scope
psi(){ awk -v k="$2" '$1==k{split($2,a,"="); print a[2]}' /proc/pressure/$1; }
cg(){ awk -v k="$2" '$1==k{split($2,a,"="); print a[2]}' $wcg/$1.pressure 2>/dev/null; }
rapl(){ sudo -n cat /sys/class/powercap/intel-rapl:0/energy_uj 2>/dev/null || echo; }
thr(){ cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count; }
stat(){ awk '/^cpu /{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat; }
[ -s $out ] || echo "ts,epoch,cpu_some10,cpu_some60,io_some10,io_full10,mem_some10,worker_cpu_some10,worker_io_some10,pkg_c,fan_rpm,load1,host_cpu_pct,worker_cpu_usec,rapl_uj,pkg_throttle" > $out
[ -s $dout ] || echo "ts,name,cpu_pct,mem_usage" > $dout
read b0 t0 < <(stat); end=$(( $(date +%s) + dur ))
while [ "$(date +%s)" -lt $end ]; do
  sleep $(( 10 - $(date +%s) % 10 ))
  ts=$(date -Iseconds); ep=$(date +%s)
  read b1 t1 < <(stat); hp=$(awk -v a=$((b1-b0)) -v b=$((t1-t0)) 'BEGIN{printf "%.1f", b?100*a/b:0}'); b0=$b1; t0=$t1
  wu=$(awk '/usage_usec/{print $2}' $wcg/cpu.stat 2>/dev/null)
  echo "$ts,$ep,$(psi cpu some),$(awk '$1=="some"{split($3,a,"="); print a[2]}' /proc/pressure/cpu),$(psi io some),$(psi io full),$(psi memory some),$(cg cpu some),$(cg io some),$(( $(cat $pkg) / 1000 )),$(cat $fan),$(cut -d' ' -f1 /proc/loadavg),$hp,$wu,$(rapl),$(thr)" >> $out
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' | sed "s|^|$ts,|; s|%||" >> $dout &
done
wait
echo "done $label $(wc -l < $out) rows"
