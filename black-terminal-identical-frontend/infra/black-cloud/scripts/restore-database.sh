#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
EXPORT_DIR=${BLACK_CLOUD_EXPORT_DIR:-}
PASSPHRASE_FILE=${BLACK_CLOUD_BACKUP_PASSPHRASE_FILE:-}
DB_CONTAINER=${BLACK_CLOUD_DB_CONTAINER:-supabase-db}
DB_USER=${BLACK_CLOUD_RESTORE_DB_USER:-supabase_admin}

test -d "$EXPORT_DIR" || { echo "BLACK_CLOUD_EXPORT_DIR is missing." >&2; exit 1; }
test -f "$PASSPHRASE_FILE" || { echo "BLACK_CLOUD_BACKUP_PASSPHRASE_FILE is missing." >&2; exit 1; }
for name in roles schema data; do test -s "$EXPORT_DIR/$name.sql.gz.enc" || { echo "$name export is missing." >&2; exit 1; }; done
(cd "$EXPORT_DIR" && sha256sum -c SHA256SUMS)

docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || { echo "Target Supabase database container is unavailable." >&2; exit 1; }
has_bt_users=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -Atqc "select (to_regclass('public.bt_users') is not null)::int")
if [ "$has_bt_users" = 1 ]; then existing=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -Atqc "select count(*) from public.bt_users"); else existing=0; fi
test "${existing:-0}" = 0 || { echo "Target database is not empty; refusing to overwrite it." >&2; exit 1; }

decrypt(){
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$PASSPHRASE_FILE" -in "$1" | gzip -dc
}

{
  decrypt "$EXPORT_DIR/roles.sql.gz.enc"
  cat "$INFRA_DIR/supabase/hosted-schema-compatibility.sql"
  decrypt "$EXPORT_DIR/schema.sql.gz.enc"
  printf 'SET session_replication_role = replica;\n'
  decrypt "$EXPORT_DIR/data.sql.gz.enc"
} | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d postgres --single-transaction --variable ON_ERROR_STOP=1

# The source production ledger stops before Event Alpha. Apply the target-only
# forward migrations after the source snapshot has restored atomically.
{
  printf 'set role postgres;\n'
  cat "$INFRA_DIR/../../supabase/migrations/20260820014838_phase5_event_alpha_engine.sql"
  cat "$INFRA_DIR/../../supabase/migrations/20260820153000_bclif_lease_column_qualification.sql"
  cat "$INFRA_DIR/../../supabase/migrations/20260820153100_bclif_storage_path_regex_correction.sql"
} | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d postgres --variable ON_ERROR_STOP=1

BLACK_CLOUD_DB_CONTAINER="$DB_CONTAINER" BLACK_CLOUD_DB_USER="$DB_USER" "$SCRIPT_DIR/bootstrap-migration-ledger.sh"

mkdir -p "$INFRA_DIR/artifacts"
chmod 700 "$INFRA_DIR/artifacts"
verification="$INFRA_DIR/artifacts/target-verification.tsv"
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -AtF $'\t' -c "select 'auth_users', count(*)::text from auth.users union all select 'public_tables', count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' union all select 'storage_buckets', count(*)::text from storage.buckets union all select 'storage_objects', count(*)::text from storage.objects;" > "$verification"
chmod 600 "$verification"
printf 'Database restore and pending Event Alpha migration completed. Run restore verification before application startup.\n'
