# Backups & restore (Postgres)

Winnow's guiding principle is that the **RAWs are touched only once** and the
NAS library is mounted **read-only** — the originals are effectively
indestructible from Winnow's side. Everything *else* — verdicts (pick/reject),
stars, colors, tags, soft-deletes, the indexed EXIF facets and, crucially, the
**source → export lineage** — lives **only in Postgres**. Lose that database and
you lose the hours of culling/curation, even though every RAW is still on the
NAS.

So Postgres is the one piece of state that genuinely needs a backup. Redis is
just a work queue (rebuildable), derivatives are a regenerable cache
(`POST /api/assets/regenerate`), exports are reproducible from a selection. This
runbook covers the database.

## What runs automatically

A `backup` sidecar service (defined in both `docker-compose.yml` and
`docker-compose-optiplex.yml`) runs alongside Postgres and, on a schedule:

1. takes a `pg_dump` of the `winnow` database (plain SQL, `--no-owner
   --no-privileges`),
2. gzips it to `winnow-<UTC timestamp>.sql.gz`,
3. prunes dumps older than the retention window.

It uses the **same `postgres:16-alpine` image as the server**, so the `pg_dump`
version always matches the database — no version-skew surprises at restore time.
A failed dump is logged and retried on the next cycle; the previous good dumps
are never deleted by a failure (a truncated dump is discarded, not promoted).

| Setting            | Default | Meaning                                   |
| ------------------ | ------- | ----------------------------------------- |
| `BACKUP_INTERVAL`  | `86400` | seconds between dumps (86400 = daily)     |
| `BACKUP_KEEP_DAYS` | `14`    | delete dumps older than N days            |

Override them in `.env` (dev) or the Portainer stack's environment (Optiplex).

**Where the dumps land**

- Dev (`docker-compose.yml`): `./backups/` in the repo (gitignored).
- Optiplex (`docker-compose-optiplex.yml`):
  `${WINNOW_DATA:-/opt/winnow}/backups/` on the host.

Watch it work:

```bash
docker compose logs -f backup
docker compose ps backup          # health = "a dump in the last 2 days exists"
ls -lh backups/                   # or /opt/winnow/backups on the Optiplex
```

> **Off-box copies — read this.** On the Optiplex the dumps sit on the **same
> box** as `pgdata`. That protects you against the likely failure modes (a bad
> migration, a wrong bulk delete, a corrupted table) but **not** against losing
> the disk. For real durability, get the dumps onto a second device:
>
> - point `WINNOW_DATA` at a different physical disk than `/opt/winnow/pgdata`, or
> - copy them to the NAS, e.g. a nightly cron on the host:
>   ```bash
>   rsync -a --delete /opt/winnow/backups/ /mnt/nas/computing/winnow-backups/
>   ```
>   (The NAS `Computing` share is already mounted RW for imports.)

## Manual backup (ad-hoc)

Before a risky migration or a big bulk edit, take a dump on demand. No `pg_dump`
needed on the host — the script shells into the container:

```bash
# Dev (docker compose):
./scripts/pg-backup.sh                       # -> ./backups/winnow-<ts>.sql.gz

# Optiplex (target the running container by name, write to the host dir):
PG_CONTAINER=winnow_postgres BACKUP_DIR=/opt/winnow/backups ./scripts/pg-backup.sh
```

### Host-cron alternative

If you'd rather not run the sidecar, schedule the script from the host instead
(it's idempotent and self-pruning). Example crontab — daily at 03:15:

```cron
15 3 * * * cd /opt/winnow/winnow && PG_CONTAINER=winnow_postgres BACKUP_DIR=/opt/winnow/backups /opt/winnow/winnow/scripts/pg-backup.sh >> /var/log/winnow-backup.log 2>&1
```

## Restore

> **Restoring is destructive**: it drops and recreates the `public` schema, then
> loads the dump. Stop the writers first so nothing races the restore.

### With the helper script

```bash
# Dev:
docker compose stop app worker
./scripts/pg-restore.sh ./backups/winnow-20260620-031500.sql.gz
docker compose start app worker

# Optiplex (by container name):
docker stop winnow_app winnow_worker
PG_CONTAINER=winnow_postgres ./scripts/pg-restore.sh /opt/winnow/backups/winnow-20260620-031500.sql.gz
docker start winnow_app winnow_worker
```

The script verifies the gzip integrity, asks for a typed `yes` confirmation
(skip with `FORCE=1`), resets the schema, and loads the dump with
`ON_ERROR_STOP=1` so a bad load fails loudly instead of half-applying.

### By hand (equivalent, if you don't have the repo on the host)

```bash
docker stop winnow_app winnow_worker

# Reset the schema, then stream the dump back in:
docker exec -i winnow_postgres psql -U winnow -d winnow -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
gunzip -c /opt/winnow/backups/winnow-20260620-031500.sql.gz \
  | docker exec -i winnow_postgres psql -U winnow -d winnow -v ON_ERROR_STOP=1 -q

docker start winnow_app winnow_worker
```

The dump includes the `schema_migrations` table, so after a restore the
`migrate` service sees every migration as already applied and is a no-op — the
app starts straight onto the restored schema.

### Sanity check after restore

```bash
docker exec -i winnow_postgres psql -U winnow -d winnow -c \
  "select (select count(*) from assets) as assets,
          (select count(*) from exports) as exports,
          (select count(*) from schema_migrations) as migrations;"
```

## Spot-check a dump without restoring

A backup you've never read is a guess. Periodically confirm a dump is loadable:

```bash
gunzip -c backups/winnow-<ts>.sql.gz | head -n 40        # looks like SQL?
gzip -t backups/winnow-<ts>.sql.gz && echo "gzip intact"  # not truncated?
```

For a full confidence check, restore the dump into a throwaway database
(`createdb winnow_verify`, load, count rows, `dropdb`) rather than over the live
one.
