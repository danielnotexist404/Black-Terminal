#!/usr/bin/env bash
set -euo pipefail

BACKUP_CONTAINER=${BLACK_CLOUD_BACKUP_CONTAINER:-black-cloud-backup-backup-1}
BACKUP_STAGING_VOLUME=${BLACK_CLOUD_BACKUP_STAGING_VOLUME:-black-cloud-backup_backup_staging}
DATABASE_IMAGE=${BLACK_CLOUD_DATABASE_IMAGE:-supabase/postgres:17.6.1.136}
DRILL_CONTAINER=${BLACK_CLOUD_RESTORE_DRILL_CONTAINER:-black-cloud-postgres-restore-drill}
DRILL_VOLUME=${BLACK_CLOUD_RESTORE_DRILL_VOLUME:-black-cloud-postgres-restore-drill-data}
RESTORE_ROOT=/staging/isolated-database-restore

cleanup() {
  docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$DRILL_VOLUME" >/dev/null 2>&1 || true
  docker exec "$BACKUP_CONTAINER" sh -c "rm -rf '$RESTORE_ROOT'" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker inspect "$BACKUP_CONTAINER" >/dev/null
docker volume inspect "$BACKUP_STAGING_VOLUME" >/dev/null
cleanup

docker exec "$BACKUP_CONTAINER" sh -c \
  "mkdir -p '$RESTORE_ROOT' && restic restore latest --target '$RESTORE_ROOT' >/tmp/isolated-database-restore.log"

docker volume create "$DRILL_VOLUME" >/dev/null
restore_password=$(openssl rand -hex 32)
docker run -d \
  --name "$DRILL_CONTAINER" \
  --network none \
  --shm-size=1g \
  --env POSTGRES_PASSWORD="$restore_password" \
  --env POSTGRES_DB=postgres \
  --volume "$DRILL_VOLUME:/var/lib/postgresql/data" \
  --volume "$BACKUP_STAGING_VOLUME:/restore:ro" \
  "$DATABASE_IMAGE" >/dev/null
unset restore_password

# The image first starts a temporary initialization server and then restarts
# PostgreSQL. Wait past that transition before attempting the isolated restore.
sleep 12
ready=false
for _attempt in $(seq 1 60); do
  if docker exec "$DRILL_CONTAINER" pg_isready -U supabase_admin -d postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true || { echo "Isolated PostgreSQL restore target did not become ready." >&2; exit 1; }

snapshot_dir=$(docker exec "$DRILL_CONTAINER" sh -c \
  "find /restore/isolated-database-restore -type f -name manifest.json -print -quit" | sed 's|/manifest.json$||')
test -n "$snapshot_dir" || { echo "Restored backup manifest is missing." >&2; exit 1; }

# The pinned Supabase PostgreSQL image pre-creates core roles. The roles dump
# adds project-specific roles; duplicate-role diagnostics are expected. The
# subsequent exit-on-error archive restore is the authoritative role/ownership
# validation and fails if any required owner is unavailable.
docker exec "$DRILL_CONTAINER" sh -c \
  "psql -U supabase_admin -d postgres -f '$snapshot_dir/roles.sql' >/tmp/roles-restore.log 2>&1 || true"
docker exec "$DRILL_CONTAINER" createdb -U supabase_admin restore_test
docker exec "$DRILL_CONTAINER" pg_restore \
  -U supabase_admin \
  -d restore_test \
  --exit-on-error \
  "$snapshot_dir/postgres.dump"

result=$(docker exec "$DRILL_CONTAINER" psql -U supabase_admin -d restore_test -AtF '|' -c \
  "select 'auth_users', count(*) from auth.users
   union all select 'bt_users', count(*) from public.bt_users
   union all select 'storage_buckets', count(*) from storage.buckets
   union all select 'migration_ledger', count(*) from supabase_migrations.schema_migrations;")
printf '%s\n' "$result"
printf 'Isolated PostgreSQL restore passed in a network-disabled disposable Docker container.\n'
