#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_DIR=$(CDPATH= cd -- "$INFRA_DIR/../.." && pwd)
DB_CONTAINER=${BLACK_CLOUD_DB_CONTAINER:-supabase-db}
DB_USER=${BLACK_CLOUD_DB_USER:-supabase_admin}
LEDGER_FILE=${BLACK_CLOUD_MIGRATION_LEDGER_FILE:-$INFRA_DIR/supabase/applied-migration-ledger.txt}

test -s "$LEDGER_FILE" || { echo "Applied migration ledger is missing." >&2; exit 1; }
work_dir=$(mktemp -d /tmp/bt-migration-ledger.XXXXXX)
trap 'rm -r "$work_dir"' EXIT
sql_file="$work_dir/ledger.sql"

cat > "$sql_file" <<'SQL'
begin;
create schema if not exists supabase_migrations authorization postgres;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
alter table supabase_migrations.schema_migrations owner to postgres;
grant usage on schema supabase_migrations to postgres, supabase_admin;
grant select, insert, update, delete on supabase_migrations.schema_migrations to postgres, supabase_admin;
SQL

count=0
while IFS='|' read -r version name; do
  test -n "$version" || continue
  case "$version" in *[!0-9]*) echo "Invalid migration version in ledger: $version" >&2; exit 1;; esac
  case "$name" in ''|*[!A-Za-z0-9_]*) echo "Invalid migration name in ledger: $name" >&2; exit 1;; esac
  migration="$REPO_DIR/supabase/migrations/${version}_${name}.sql"
  test -s "$migration" || { echo "Ledger references a missing repository migration: ${version}_${name}.sql" >&2; exit 1; }
  printf "insert into supabase_migrations.schema_migrations(version, statements, name) values ('%s', array[]::text[], '%s') on conflict (version) do update set name=excluded.name;\n" "$version" "$name" >> "$sql_file"
  count=$((count + 1))
done < "$LEDGER_FILE"

printf 'commit;\n' >> "$sql_file"
test "$count" -gt 0 || { echo "Applied migration ledger is empty." >&2; exit 1; }
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d postgres --variable ON_ERROR_STOP=1 < "$sql_file" >/dev/null

target_count=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -Atqc 'select count(*) from supabase_migrations.schema_migrations')
target_latest=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -Atqc 'select max(version) from supabase_migrations.schema_migrations')
expected_latest=$(tail -n 1 "$LEDGER_FILE" | cut -d '|' -f 1)
test "$target_count" = "$count" || { echo "Migration ledger count mismatch: expected=$count target=$target_count" >&2; exit 1; }
test "$target_latest" = "$expected_latest" || { echo "Migration ledger latest version mismatch: expected=$expected_latest target=$target_latest" >&2; exit 1; }
printf 'Migration ledger reconstructed: versions=%s latest=%s.\n' "$target_count" "$target_latest"
