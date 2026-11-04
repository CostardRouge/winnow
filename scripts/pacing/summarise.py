"""Summarise a phase-0 recording: python3 -I summarise.py LABEL [LABEL...]"""
import csv, os, sys, statistics as st
from collections import defaultdict
D = os.environ.get('PACING_DIR', os.path.expanduser('~/winnow-pacing')) + '/'
def p(xs, q):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else float('nan')
for label in sys.argv[1:]:
    rows = list(csv.DictReader(open(D + label + '.csv')))
    print(f'## {label}: {len(rows)} samples, {rows[0]["ts"]} .. {rows[-1]["ts"]}')
    for k in ['cpu_some10', 'io_some10', 'io_full10', 'worker_cpu_some10', 'host_cpu_pct', 'pkg_c', 'fan_rpm', 'load1']:
        v = [float(r[k]) for r in rows if r[k] not in ('', None)]
        print(f'  {k:18} mean={st.mean(v):7.2f} p95={p(v,.95):7.2f} max={max(v):7.2f} min={min(v):7.2f}')
    w = [(int(r['epoch']), int(r['worker_cpu_usec'])) for r in rows if r['worker_cpu_usec']]
    if len(w) > 1:
        cores = [(b[1] - a[1]) / 1e6 / (b[0] - a[0]) for a, b in zip(w, w[1:]) if b[0] > a[0]]
        print(f'  worker_cores       mean={st.mean(cores):7.2f} p95={p(cores,.95):7.2f} max={max(cores):7.2f}')
    e = [(int(r['epoch']), int(r['rapl_uj'])) for r in rows if r.get('rapl_uj')]
    if len(e) > 1:
        w_ = [(b[1] - a[1]) / 1e6 / (b[0] - a[0]) for a, b in zip(e, e[1:]) if b[0] > a[0] and b[1] >= a[1]]
        print(f'  package_watts      mean={st.mean(w_):7.1f} p95={p(w_,.95):7.1f} max={max(w_):7.1f}')
    t = [int(r['pkg_throttle']) for r in rows if r.get('pkg_throttle')]
    if t: print(f'  package_throttle   +{t[-1]-t[0]} events')
    d = defaultdict(list)
    for r in csv.DictReader(open(D + label + '-docker.csv')):
        try: d[r['name']].append(float(r['cpu_pct']))
        except ValueError: pass
    top = sorted(d.items(), key=lambda kv: -st.mean(kv[1]))[:10]
    print('  docker cpu% (mean / p95 / max):')
    for n, v in top:
        print(f'    {n:34} {st.mean(v):7.1f} {p(v,.95):7.1f} {max(v):7.1f}')
    tot = defaultdict(float)
    for n, v in d.items():
        pass
