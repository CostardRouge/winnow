"""Per-run analysis of an exp.sh experiment: python3 -I exp-analyse.py LABEL
(reads $PACING_DIR/exp/runs.csv and $PACING_DIR/LABEL.csv + LABEL-docker.csv)."""
import csv, os, sys, statistics as st
from collections import defaultdict
D = os.environ.get('PACING_DIR', os.path.expanduser('~/winnow-pacing')) + '/'
WRAP = 262143328850
rows = [r for r in csv.DictReader(open(D + sys.argv[1] + '.csv'))]
S = [dict(ep=int(r['epoch']), pkg=int(r['pkg_c']), fan=int(r['fan_rpm']), cpu=float(r['host_cpu_pct']),
          rapl=int(r['rapl_uj']) if r['rapl_uj'] else None, thr=int(r['pkg_throttle']),
          wu=int(r['worker_cpu_usec']) if r['worker_cpu_usec'] else None,
          psi=float(r['cpu_some10'])) for r in rows]
runs = list(csv.DictReader(open(D + 'exp/runs.csv')))
known = {'winnow-worker','winnow-redis','winnow-postgres','winnow-app','watchtower','umami-db','umami','traefik','start-retry',
 'spotify-poller','spotify-calendar','snmp-exporter','regie','prometheus','postiz-temporal-postgresql','postiz-temporal-elasticsearch',
 'postiz-temporal','postiz-redis','postiz-postgres','postiz','portainer','pihole','paperclip-db','paperclip','openspeedtest','nut-exporter',
 'ntfy','node-exporter','n8n','myst','motion-pipeline_redis','motion-pipeline_postgres','motion-pipeline_minio','motion-pipeline-front',
 'metube','loki','immich_machine_learning','honeygain','cloudflared','cadvisor','autoheal','grafana','glance','home-assistant'}
dk = defaultdict(lambda: defaultdict(float))  # ts -> {'exp':cpu, 'other':cpu}
from datetime import datetime
for r in csv.DictReader(open(D + sys.argv[1] + '-docker.csv')):
    try: c = float(r['cpu_pct'])
    except ValueError: continue
    ep = int(datetime.fromisoformat(r['ts']).timestamp())
    k = 'exp' if (r['name'] not in known and not r['name'].startswith('homelab-runner')) else 'other'
    dk[ep][k] += c
def d(a, b): x = b - a; return x + WRAP if x < 0 else x
def watts(i0, i1): return d(S[i0]['rapl'], S[i1]['rapl']) / 1e6 / (S[i1]['ep'] - S[i0]['ep'])
out = []
for n, r in enumerate(runs):
    s, e = int(r['start']), int(r['end'])
    nxt = int(runs[n+1]['start']) if n + 1 < len(runs) else S[-1]['ep']
    ia = max(i for i, x in enumerate(S) if x['ep'] <= s)
    ib = min(i for i, x in enumerate(S) if x['ep'] >= e)
    ip = max(i for i, x in enumerate(S) if x['ep'] <= s - 60)  # 60 s baseline before
    base_w = watts(ip, ia)
    span = S[ib]['ep'] - S[ia]['ep']
    ej = d(S[ia]['rapl'], S[ib]['rapl']) / 1e6
    inrun = S[ia+1:ib+1]
    after = [x for x in S if e < x['ep'] <= nxt]
    win = [x for x in S if s < x['ep'] <= nxt]
    rec = next((x['ep'] - e for x in after if x['fan'] < 1900), None)
    fanmax = max(x['fan'] for x in win); tfanmax = next(x['ep'] for x in win if x['fan'] == fanmax) - e
    exp_cores = [dk[x['ep']]['exp'] / 100 for x in inrun if x['ep'] in dk]
    wcores = (inrun[-1]['wu'] - S[ia]['wu']) / 1e6 / span if S[ia]['wu'] and inrun[-1]['wu'] else None
    out.append(dict(cond=f"{r['cond']}/{'T' if r['turbo']=='1' else 'noT'}", load=r['load'], secs=int(r['secs']),
        start_pkg=S[ia]['pkg'], start_fan=S[ia]['fan'], base_w=base_w, ej=ej, net_j=ej - base_w * span,
        mean_w=ej / span, peak_w=max(watts(i-1, i) for i in range(ia+1, ib+1)),
        pkg_mean=st.mean(x['pkg'] for x in inrun), pkg_max=max(x['pkg'] for x in inrun),
        t95=sum(x['pkg'] >= 95 for x in inrun), n=len(inrun),
        thr=S[ib]['thr'] - S[ia]['thr'], cpu=st.mean(x['cpu'] for x in inrun), psi=max(x['psi'] for x in inrun),
        cores=st.mean(exp_cores) if exp_cores else float('nan'), wcores=wcores,
        fanmax=fanmax, tfanmax=tfanmax, rec=rec, gap=nxt - e))
for o in out:
    print(f"{o['cond']:28} {o['load']:4} {o['secs']:4}s | start {o['start_pkg']}C {o['start_fan']}rpm base {o['base_w']:.1f}W | "
          f"E {o['ej']:.0f}J net {o['net_j']:.0f}J mean {o['mean_w']:.1f}W peak {o['peak_w']:.1f}W | pkg {o['pkg_mean']:.0f}/{o['pkg_max']} "
          f">=95 {o['t95']}/{o['n']} thr +{o['thr']} | host {o['cpu']:.0f}% psi {o['psi']:.1f} expcores {o['cores']:.2f} worker {o['wcores']:.2f} | "
          f"fan max {o['fanmax']} @+{o['tfanmax']}s back<1900 +{o['rec']}s (gap {o['gap']})")
# fan trace around each run
print()
for n, r in enumerate(runs):
    s, e = int(r['start']), int(r['end'])
    tr = [(x['ep'] - s, x['pkg'], x['fan']) for x in S if s - 20 <= x['ep'] <= e + 240]
    print(r['cond'], r['turbo'], r['load'], ' '.join(f"{t}:{p}/{f}" for t, p, f in tr))
