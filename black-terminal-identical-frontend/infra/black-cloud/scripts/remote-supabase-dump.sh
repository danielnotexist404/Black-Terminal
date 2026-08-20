#!/usr/bin/env bash
set -euo pipefail

MODE=${1:-}
ENV_FILE=${2:-}
case "$ENV_FILE" in /tmp/bt-pg.*) ;; *) echo "Invalid temporary database environment path." >&2; exit 1;; esac
test -f "$ENV_FILE" || { echo "Temporary database environment is missing." >&2; exit 1; }

POSTGRES_IMAGE=${POSTGRES_DUMP_IMAGE:-postgres:17-alpine}
run_pg(){ docker run --rm -i --network host --env-file "$ENV_FILE" "$POSTGRES_IMAGE" "$@"; }

case "$MODE" in
  roles)
    run_pg pg_dumpall --roles-only --role postgres --quote-all-identifiers --no-role-passwords --no-comments \
      | sed -E 's/^\\(un)?restrict .*$/-- &/' \
      | sed -E 's/^CREATE ROLE "(anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin)"/-- &/' \
      | sed -E 's/^ALTER ROLE "(anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin)"/-- &/' \
      | sed -E 's/ (NOSUPERUSER|NOREPLICATION)//g' \
      | sed -E 's/^-- (.* SET "(pgaudit.*|pgrst.*|session_replication_role|statement_timeout|track_io_timing)" .*)/\1/' \
      | sed -E 's/GRANT ".*" TO "(anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin)"/-- &/' \
      | sed -E '/^--/d' \
      | uniq
    printf 'RESET ALL;\n'
    ;;
  schema)
    excluded='information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault'
    run_pg pg_dump --schema-only --quote-all-identifiers --role postgres --exclude-schema "$excluded" \
      | sed -E 's/^\\(un)?restrict .*$/-- &/' \
      | sed -E 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' \
      | sed -E 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/' \
      | sed -E 's/^CREATE SEQUENCE "/CREATE SEQUENCE IF NOT EXISTS "/' \
      | sed -E 's/^CREATE VIEW "/CREATE OR REPLACE VIEW "/' \
      | sed -E 's/^CREATE FUNCTION "/CREATE OR REPLACE FUNCTION "/' \
      | sed -E 's/^CREATE TRIGGER "/CREATE OR REPLACE TRIGGER "/' \
      | sed -E 's/^CREATE PUBLICATION "supabase_realtime/-- &/' \
      | sed -E 's/^CREATE EVENT TRIGGER /-- &/' \
      | sed -E 's/^         WHEN TAG IN /-- &/' \
      | sed -E 's/^   EXECUTE FUNCTION /-- &/' \
      | sed -E 's/^ALTER EVENT TRIGGER /-- &/' \
      | sed -E 's/^ALTER PUBLICATION "supabase_realtime_/-- &/' \
      | sed -E 's/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /-- &/' \
      | sed -E 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/' \
      | sed -E 's/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/-- &/' \
      | sed -E "s/^GRANT (.+) ON (.+) \"($excluded)\"/-- &/" \
      | sed -E "s/^REVOKE (.+) ON (.+) \"($excluded)\"/-- &/" \
      | sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/\1;/' \
      | sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/\1;/' \
      | sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/\1;/' \
      | sed -E 's/^COMMENT ON EXTENSION (.+)/-- &/' \
      | sed -E 's/^CREATE POLICY "cron_job_/-- &/' \
      | sed -E 's/^ALTER TABLE "cron"/-- &/' \
      | sed -E 's/^SET transaction_timeout = 0;/-- &/' \
      | sed -E '/^--/d'
    ;;
  data)
    excluded='information_schema|pg_*|graphql|graphql_public|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault|etl|extensions|pgbouncer|realtime|supabase_migrations|_analytics|_realtime|_supavisor'
    run_pg pg_dump --data-only --quote-all-identifiers --role postgres \
      --exclude-schema "$excluded" \
      --exclude-table auth.schema_migrations \
      --exclude-table storage.migrations \
      --exclude-table supabase_functions.migrations \
      --schema '*' \
      | sed -E 's/^\\(un)?restrict .*$/-- &/'
    printf 'RESET ALL;\n'
    ;;
  verification)
    run_pg psql -X -v ON_ERROR_STOP=1 -AtF $'\t' <<'SQL'
set role postgres;
select 'postgres_version', current_setting('server_version');
select 'auth_users', count(*)::text from auth.users;
select 'public_tables', count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r';
select 'public_functions', count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';
select 'public_policies', count(*)::text from pg_policies where schemaname='public';
select 'storage_buckets', count(*)::text from storage.buckets;
select 'storage_objects', count(*)::text from storage.objects;
select 'storage_bytes', coalesce(sum((metadata->>'size')::bigint),0)::text from storage.objects where metadata ? 'size';
select 'database_bytes', pg_database_size(current_database())::text;
select 'extensions', string_agg(extname,',' order by extname) from pg_extension;
select 'realtime_tables', count(*)::text from pg_publication_tables where pubname='supabase_realtime';
select 'cron_job_table_present', (to_regclass('cron.job') is not null)::int::text;
select 'bt_users', count(*)::text from public.bt_users;
select 'exchange_accounts', count(*)::text from public.exchange_accounts;
select 'execution_orders', count(*)::text from public.execution_orders;
select 'investment_groups', count(*)::text from public.investment_groups;
select 'profiles_extended', count(*)::text from public.profiles_extended;
SQL
    ;;
  compatibility)
    run_pg psql -X -v ON_ERROR_STOP=1 -AtF $'\t' <<'SQL'
set role postgres;
select table_schema, table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default, '')
from information_schema.columns
where table_schema in ('auth', 'storage')
order by table_schema, table_name, ordinal_position;
SQL
    ;;
  *) echo "Mode must be roles, schema, data, verification, or compatibility." >&2; exit 1;;
esac
