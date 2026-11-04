#!/usr/bin/env bash
# Reaction delays for assets indexed since T0. usage: reaction.sh T0_EPOCH [COPY_END_EPOCH]
# Read-only: Postgres SELECT + Redis HGET of finished derivative jobs.
set -eu
t0=$1; ce=${2:-$1}; d=${PACING_DIR:-$HOME/winnow-pacing}
docker exec winnow-postgres psql -U winnow -d winnow -At -F'	' -c "SELECT id, lower(ext), media_type, file_size, coalesce(duration_s,0), extract(epoch from created_at), (thumb_key IS NOT NULL), derivative_status FROM assets WHERE created_at >= to_timestamp($t0) ORDER BY created_at" > $d/import-assets.tsv
docker exec winnow-redis sh -c 'for id in $(redis-cli ZRANGEBYSCORE bull:winnow-derivatives:completed '"$((t0*1000))"' +inf); do printf "%s\t%s\t%s\t%s\n" "$(redis-cli HGET bull:winnow-derivatives:$id data | tr -d "\n\t")" "$(redis-cli HGET bull:winnow-derivatives:$id timestamp)" "$(redis-cli HGET bull:winnow-derivatives:$id processedOn)" "$(redis-cli HGET bull:winnow-derivatives:$id finishedOn)"; done' > $d/import-deriv.tsv
python3 -I - "$ce" "$d/" <<'PY'
import csv,json,sys,statistics as st
ce=float(sys.argv[1]); d=sys.argv[2]
A={int(r[0]):r for r in csv.reader(open(d+'import-assets.tsv'),delimiter='\t')}
J={}
for r in csv.reader(open(d+'import-deriv.tsv'),delimiter='\t'):
    try: J[json.loads(r[0])['assetId']]=(int(r[1])/1000,int(r[2])/1000,int(r[3])/1000)
    except Exception: pass
print('assets indexed',len(A),' derivative jobs finished',len(J))
if not A: sys.exit()
idx=sorted(float(a[5]) for a in A.values())
print(f'first indexed  +{idx[0]-ce:.0f}s   last indexed +{idx[-1]-ce:.0f}s (from copy end)')
for kind in ('photo','video'):
    f=sorted(J[i][2] for i,a in A.items() if a[2]==kind and i in J)
    if f: print(f'{kind}: first derivative +{f[0]-ce:.0f}s, last +{f[-1]-ce:.0f}s, n={len(f)}')
from collections import defaultdict
g=defaultdict(list)
for i,a in A.items():
    if i in J: g[(a[1],a[2])].append((J[i][2]-J[i][1], float(a[4])))
for k,v in sorted(g.items()):
    w=[x[0] for x in v]; extra=''
    if k[1]=='video':
        r=[x[0]/x[1] for x in v if x[1]>0]; extra=f' clip_s median={st.median([x[1] for x in v]):.0f}; wall/clip_s median={st.median(r):.2f}' if r else ''
    print(k,f'n={len(w)} median={st.median(w):.2f}s max={max(w):.1f}s'+extra)
PY
