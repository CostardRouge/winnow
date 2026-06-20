#!/usr/bin/env bash
# Winnow — restore a Postgres dump produced by scripts/pg-backup.sh or the
# `backup` sidecar (winnow-*.sql.gz).
#
# DESTRUCTIVE: this drops and recreates the `public` schema before loading the
# dump, replacing the current database contents. Stop the app and worker first
# so nothing writes mid-restore:
#
#   docker compose stop app worker
#   ./scripts/pg-restore.sh ./backups/winnow-20260620-031500.sql.gz
#   docker compose start app worker
#
# On the Optiplex/Portainer host (no compose file handy), target the container
# by name instead:
#
#   docker stop winnow_app winnow_worker
#   PG_CONTAINER=winnow_postgres ./scripts/pg-restore.sh /opt/winnow/backups/winnow-….sql.gz
#   docker start winnow_app winnow_worker
#
# Env (all optional):
#   FORCE=1            skip the confirmation prompt
#   PG_CONTAINER       postgres container name (docker exec)  (else docker compose)
#   COMPOSE_FILE       compose file for `docker compose exec` (default docker-compose.yml)
#   PG_SERVICE         compose service name                   (default postgres)
#   PGDATABASE/PGUSER  database / role                        (default winnow/winnow)
set -euo pipefail

DUMP="${1:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
DB="${PGDATABASE:-winnow}"
USER="${PGUSER:-winnow}"

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "usage: $0 <path-to-winnow-*.sql.gz>" >&2
  exit 2
fi

if ! gzip -t "$DUMP" 2>/dev/null; then
  echo "[pg-restore] '$DUMP' is not a valid gzip file — refusing to restore" >&2
  exit 1
fi

# Run a command inside the postgres container, passing stdin through.
pg() {
  if [ -n "${PG_CONTAINER:-}" ]; then
    docker exec -i "$PG_CONTAINER" "$@"
  else
    docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" "$@"
  fi
}

if [ "${FORCE:-0}" != "1" ]; then
  printf 'This will OVERWRITE database "%s" with %s.\nType "yes" to continue: ' "$DB" "$DUMP"
  read -r ans
  [ "$ans" = "yes" ] || { echo "aborted"; exit 1; }
fi

echo "[pg-restore] resetting schema in '$DB'"
pg psql -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

echo "[pg-restore] loading $DUMP"
gunzip -c "$DUMP" | pg psql -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -q

echo "[pg-restore] done. Restart the app: docker compose start app worker"
