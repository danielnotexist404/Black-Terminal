#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_DIR=$(CDPATH= cd -- "$INFRA_DIR/../.." && pwd)
MIGRATION_DIR=${BLACK_CLOUD_MIGRATION_DIR:-"$REPO_DIR/supabase/migrations"}
DB_CONTAINER=${BLACK_CLOUD_DB_CONTAINER:-supabase-db}
DB_USER=${BLACK_CLOUD_DB_USER:-postgres}
DB_NAME=${BLACK_CLOUD_DB_NAME:-postgres}
LOCK_ROOT=${BLACK_CLOUD_MIGRATION_LOCK_ROOT:-/var/lock/black-cloud}
ACTION=${1:-apply}

case "$ACTION" in
  apply|verify) ;;
  *) echo "Usage: $0 [apply|verify]" >&2; exit 2 ;;
esac

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required." >&2; exit 1; }
test -d "$MIGRATION_DIR" || { echo "Migration directory is missing: $MIGRATION_DIR" >&2; exit 1; }
docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || { echo "Database container is unavailable: $DB_CONTAINER" >&2; exit 1; }

mkdir -p "$LOCK_ROOT"
LOCK_DIR="$LOCK_ROOT/repository-migrations.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another repository migration process owns $LOCK_DIR; refusing concurrent execution." >&2
  exit 75
fi
cleanup(){ rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

mapfile -t migrations < <(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
test "${#migrations[@]}" -gt 0 || { echo "No repository migrations were found." >&2; exit 1; }

declare -A seen_versions=()
for filename in "${migrations[@]}"; do
  if [[ ! "$filename" =~ ^([0-9]+)_([A-Za-z0-9_]+)\.sql$ ]]; then
    echo "Invalid migration filename: $filename" >&2
    exit 1
  fi
  version=${BASH_REMATCH[1]}
  if [ -n "${seen_versions[$version]:-}" ]; then
    echo "Duplicate migration version: $version" >&2
    exit 1
  fi
  seen_versions[$version]=$filename
done

psql_exec(){
  docker exec -i "$DB_CONTAINER" psql -X -U "$DB_USER" -d "$DB_NAME" --set ON_ERROR_STOP=1 "$@"
}

psql_scalar(){
  docker exec "$DB_CONTAINER" psql -X -U "$DB_USER" -d "$DB_NAME" -Atq --set ON_ERROR_STOP=1 -c "$1"
}

ledger_exists=$(psql_scalar "select case when to_regclass('black_terminal_ops.repository_migrations') is null then 0 else 1 end")
known_app_schema=$(psql_scalar "select case when to_regclass('public.bt_users') is null then 0 else 1 end")
if [ "$ledger_exists" = 0 ] && [ "$known_app_schema" != 0 ]; then
  echo "Application tables already exist without the checksum ledger. Refusing to overlay an untracked database." >&2
  echo "Use the documented restore/import workflow and reconcile its migration ledger first." >&2
  exit 1
fi

psql_exec >/dev/null <<'SQL'
begin;
create schema if not exists black_terminal_ops authorization postgres;
create table if not exists black_terminal_ops.repository_migrations (
  version text primary key,
  name text not null,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('applying', 'applied', 'failed')),
  started_at timestamptz not null default now(),
  applied_at timestamptz,
  failed_at timestamptz
);
alter table black_terminal_ops.repository_migrations owner to postgres;
revoke all on schema black_terminal_ops from public, anon, authenticated;
revoke all on table black_terminal_ops.repository_migrations from public, anon, authenticated;
create schema if not exists supabase_migrations authorization postgres;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
commit;
SQL

applied=0
for filename in "${migrations[@]}"; do
  [[ "$filename" =~ ^([0-9]+)_([A-Za-z0-9_]+)\.sql$ ]]
  version=${BASH_REMATCH[1]}
  name=${BASH_REMATCH[2]}
  path="$MIGRATION_DIR/$filename"
  checksum=$(sha256sum "$path" | awk '{print $1}')
  state=$(psql_scalar "select concat_ws('|', status, checksum_sha256, name) from black_terminal_ops.repository_migrations where version = '$version'")

  if [ -n "$state" ]; then
    IFS='|' read -r status recorded_checksum recorded_name <<< "$state"
    test "$recorded_checksum" = "$checksum" || { echo "Checksum drift detected for $filename." >&2; exit 1; }
    test "$recorded_name" = "$name" || { echo "Migration-name drift detected for version $version." >&2; exit 1; }
    test "$status" = applied || { echo "Migration $filename is in fail-closed state '$status'; inspect the database before retrying." >&2; exit 1; }
    applied=$((applied + 1))
    continue
  fi

  if [ "$ACTION" = verify ]; then
    echo "Migration is not recorded as applied: $filename" >&2
    exit 1
  fi

  psql_exec >/dev/null <<SQL
insert into black_terminal_ops.repository_migrations(version, name, checksum_sha256, status)
values ('$version', '$name', '$checksum', 'applying');
SQL

  printf 'Applying repository migration %s ...\n' "$filename"
  if grep -Eiq '^[[:space:]]*begin[[:space:]]*;' "$path"; then
    if ! psql_exec < "$path" >/dev/null; then
      psql_exec >/dev/null <<SQL
update black_terminal_ops.repository_migrations
set status = 'failed', failed_at = now()
where version = '$version' and status = 'applying';
SQL
      echo "Migration failed and was sealed for operator inspection: $filename" >&2
      exit 1
    fi
  elif ! psql_exec --single-transaction < "$path" >/dev/null; then
    psql_exec >/dev/null <<SQL
update black_terminal_ops.repository_migrations
set status = 'failed', failed_at = now()
where version = '$version' and status = 'applying';
SQL
    echo "Migration failed and was sealed for operator inspection: $filename" >&2
    exit 1
  fi

  psql_exec >/dev/null <<SQL
begin;
update black_terminal_ops.repository_migrations
set status = 'applied', applied_at = now(), failed_at = null
where version = '$version' and status = 'applying';
insert into supabase_migrations.schema_migrations(version, statements, name)
values ('$version', array[]::text[], '$name')
on conflict (version) do update set name = excluded.name;
commit;
SQL
  applied=$((applied + 1))
done

expected_count=${#migrations[@]}
recorded_count=$(psql_scalar "select count(*) from black_terminal_ops.repository_migrations where status = 'applied'")
recorded_latest=$(psql_scalar "select max(version) from black_terminal_ops.repository_migrations where status = 'applied'")
supabase_count=$(psql_scalar "select count(*) from supabase_migrations.schema_migrations where version in (select version from black_terminal_ops.repository_migrations where status = 'applied')")
expected_latest=${migrations[$((expected_count - 1))]%%_*}

test "$applied" = "$expected_count" || { echo "Migration traversal mismatch: expected=$expected_count traversed=$applied" >&2; exit 1; }
test "$recorded_count" = "$expected_count" || { echo "Checksum ledger mismatch: expected=$expected_count recorded=$recorded_count" >&2; exit 1; }
test "$supabase_count" = "$expected_count" || { echo "Supabase ledger mismatch: expected=$expected_count recorded=$supabase_count" >&2; exit 1; }
test "$recorded_latest" = "$expected_latest" || { echo "Latest migration mismatch: expected=$expected_latest recorded=$recorded_latest" >&2; exit 1; }

printf 'Repository migrations %s: count=%s latest=%s checksums=verified.\n' "$ACTION" "$recorded_count" "$recorded_latest"
