#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
EXPORT_DIR=${BLACK_CLOUD_EXPORT_DIR:-}
PASSPHRASE_FILE=${BLACK_CLOUD_BACKUP_PASSPHRASE_FILE:-}
DB_CONTAINER=${BLACK_CLOUD_DB_CONTAINER:-supabase-db}
DB_USER=${BLACK_CLOUD_DB_USER:-supabase_admin}

test -s "$EXPORT_DIR/source-verification.tsv.enc" || { echo "Encrypted source verification is missing." >&2; exit 1; }
test -f "$PASSPHRASE_FILE" || { echo "Backup passphrase is missing." >&2; exit 1; }
work_dir=$(mktemp -d /tmp/bt-restore-verify.XXXXXX)
trap 'rm -r "$work_dir"' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$PASSPHRASE_FILE" -in "$EXPORT_DIR/source-verification.tsv.enc" > "$work_dir/source.tsv"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -AtF $'\t' > "$work_dir/target.tsv" <<'SQL'
select 'auth_users', count(*)::text from auth.users;
select 'public_tables', count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r';
select 'storage_buckets', count(*)::text from storage.buckets;
select 'storage_objects', count(*)::text from storage.objects;
select 'bt_users', count(*)::text from public.bt_users;
select 'exchange_accounts', count(*)::text from public.exchange_accounts;
select 'execution_orders', count(*)::text from public.execution_orders;
select 'investment_groups', count(*)::text from public.investment_groups;
select 'profiles_extended', count(*)::text from public.profiles_extended;
select 'event_alpha_tables', count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'event_alpha_%';
select 'migration_ledger_count', count(*)::text from supabase_migrations.schema_migrations;
select 'migration_ledger_latest', max(version) from supabase_migrations.schema_migrations;
SQL

value(){ awk -F '\t' -v key="$1" '$1==key {print $2; exit}' "$2"; }
for key in auth_users storage_buckets storage_objects bt_users exchange_accounts execution_orders investment_groups profiles_extended; do
  source_value=$(value "$key" "$work_dir/source.tsv")
  target_value=$(value "$key" "$work_dir/target.tsv")
  test -n "$source_value" && test "$source_value" = "$target_value" || { echo "RESTORE FAIL: $key source=$source_value target=$target_value" >&2; exit 1; }
  printf 'RESTORE PASS: %s=%s\n' "$key" "$target_value"
done

event_alpha_tables=$(value event_alpha_tables "$work_dir/target.tsv")
test "${event_alpha_tables:-0}" -gt 0 || { echo "RESTORE FAIL: pending Event Alpha migration is absent." >&2; exit 1; }

expected_migrations=$(grep -Ec '^[0-9]+\|[A-Za-z0-9_]+$' "$INFRA_DIR/supabase/applied-migration-ledger.txt")
expected_latest=$(tail -n 1 "$INFRA_DIR/supabase/applied-migration-ledger.txt" | cut -d '|' -f 1)
target_migrations=$(value migration_ledger_count "$work_dir/target.tsv")
target_latest=$(value migration_ledger_latest "$work_dir/target.tsv")
test "$target_migrations" = "$expected_migrations" || { echo "RESTORE FAIL: migration ledger count expected=$expected_migrations target=$target_migrations" >&2; exit 1; }
test "$target_latest" = "$expected_latest" || { echo "RESTORE FAIL: migration ledger latest expected=$expected_latest target=$target_latest" >&2; exit 1; }

source_public=$(value public_tables "$work_dir/source.tsv")
target_public=$(value public_tables "$work_dir/target.tsv")
test "${target_public:-0}" -ge "${source_public:-0}" || { echo "RESTORE FAIL: target public schema lost tables." >&2; exit 1; }

mkdir -p "$INFRA_DIR/artifacts"
printf 'verified_at=%s\nsource_public_tables=%s\ntarget_public_tables=%s\nevent_alpha_tables=%s\nmigration_ledger_count=%s\nmigration_ledger_latest=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$source_public" "$target_public" "$event_alpha_tables" "$target_migrations" "$target_latest" > "$INFRA_DIR/artifacts/RESTORE_VERIFIED"
chmod 600 "$INFRA_DIR/artifacts/RESTORE_VERIFIED"
printf 'Restore verification passed; identity, storage metadata, and critical control-plane row counts match.\n'
