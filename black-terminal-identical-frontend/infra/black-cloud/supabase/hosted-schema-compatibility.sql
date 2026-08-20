-- Source-derived compatibility bridge for the hosted Auth/Storage schema that
-- was audited on 2026-08-20. These columns exist in the hosted PG17 source but
-- are newer than the pinned official self-hosted bundle. Definitions match the
-- source information_schema catalog exactly. No application row is changed.

set role supabase_auth_admin;

alter table auth.custom_oauth_providers
  add column if not exists custom_claims_allowlist text[] not null default '{}'::text[];

reset role;
set role supabase_storage_admin;

alter table storage.buckets
  add column if not exists versioning_status text not null default 'DISABLED'::text;

alter table storage.objects
  add column if not exists archived_at timestamptz,
  add column if not exists is_delete_marker boolean not null default false,
  add column if not exists is_versioned boolean not null default false;

reset role;
