#!/usr/bin/env bash
# Finished/active derivative + ml jobs since EPOCH_MS (read-only). usage: jobs.sh EPOCH_MS [queue]
q=${2:-winnow-derivatives}
docker exec winnow-redis sh -c '
q='"$q"'; since='"$1"'
for st in active; do for id in $(redis-cli LRANGE bull:$q:$st 0 -1); do echo "active $id $(redis-cli HGET bull:$q:$id data | tr -d "\n") proc=$(redis-cli HGET bull:$q:$id processedOn)"; done; done
for id in $(redis-cli ZRANGEBYSCORE bull:$q:completed $since +inf); do
  p=$(redis-cli HGET bull:$q:$id processedOn); f=$(redis-cli HGET bull:$q:$id finishedOn); t=$(redis-cli HGET bull:$q:$id timestamp)
  echo "done $id $(redis-cli HGET bull:$q:$id data | tr -d "\n") queued=$t proc=$p fin=$f wall_ms=$((f-p)) wait_ms=$((p-t))"
done
for id in $(redis-cli ZRANGEBYSCORE bull:$q:failed $since +inf); do echo "FAILED $id $(redis-cli HGET bull:$q:$id data | tr -d "\n") $(redis-cli HGET bull:$q:$id failedReason | head -c 200)"; done'
