#!/usr/bin/env bash
# Winnow — one-shot Postgres backup, run from the HOST.
#
# The database is the source of truth for all the curation work (verdicts,
# stars, tags, notes, the source→export lineage). The RAWs on the NAS are
# read-only and never lost; this state only ever lives in Postgres, so it must
# be dumped somewhere we can restore from.
#
# Scheduled backups already run automatically via the `backup` sidecar in
# docker-compose (default: daily). Use THIS script for an ad-hoc dump — e.g.
# right before a risky migration — or from host cron if you prefer cron to the
# sidecar. It shells into the postgres container, so no `pg_dump` is required on
# the host.
#
# Usage:
#   ./scripts/pg-backup.sh                       # dump into ./backups
#   BACKUP_DIR=/mnt/nas/winnow ./scripts/pg-backup.sh
#   PG_CONTAINER=winnow_postgres ./scripts/pg-backup.sh   # target a container by name
#
# Env (all optional):
#   BACKUP_DIR         where dumps land                       (default ./backups)
#   BACKUP_KEEP_DAYS   delete dumps older than N days         (default 14)
#   PG_CONTAINER       postgres container name (docker exec)  (else docker compose)
#   COMPOSE_FILE       compose file for `docker compose exec` (default docker-compose.yml)
#   PG_SERVICE         compose service name                   (default postgres)
#   PGDATABASE/PGUSER  database / role                        (default winnow/winnow)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
DB="${PGDATABASE:-winnow}"
USER="${PGUSER:-winnow}"

# Run a command inside the postgres container, passing stdin/stdout through.
pg() {
  if [ -n "${PG_CONTAINER:-}" ]; then
    docker exec -i "$PG_CONTAINER" "$@"
  else
    docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" "$@"
  fi
}

ts="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
final="$BACKUP_DIR/winnow-$ts.sql.gz"
tmp="$final.tmp"

echo "[pg-backup] dumping database '$DB' -> $final"
# pipefail (set above) makes a pg_dump failure fail the whole pipeline, so a
# truncated stream never gets promoted to a real dump.
if pg pg_dump -U "$USER" --format=plain --no-owner --no-privileges "$DB" | gzip -6 > "$tmp"; then
  if gzip -t "$tmp" && [ -s "$tmp" ]; then
    mv "$tmp" "$final"
    echo "[pg-backup] wrote $(du -h "$final" | cut -f1)  $final"
  else
    echo "[pg-backup] FAILED: dump is empty or corrupt — not keeping it" >&2
    rm -f "$tmp"
    exit 1
  fi
else
  echo "[pg-backup] FAILED: pg_dump returned an error — not keeping it" >&2
  rm -f "$tmp"
  exit 1
fi

# Retention: drop dumps older than KEEP_DAYS. Never touches anything but our own
# winnow-*.sql.gz files.
find "$BACKUP_DIR" -maxdepth 1 -name 'winnow-*.sql.gz' -type f -mtime +"$KEEP_DAYS" -print -exec rm -f {} \;
echo "[pg-backup] retention: kept dumps from the last $KEEP_DAYS day(s)"
