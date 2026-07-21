-- BLACK TERMINAL - Project Obsidian
-- Phase V, Chapter I: Black Cloud Execution Fabric foundation
-- Apply after the Phase IV Professional Network Chapter II migrations.
--
-- Rollback is intentionally not automated because this migration introduces
-- durable execution and audit records. Disable feature flags, drain commands,
-- revoke active mandates/secrets, export the audit ledger, then remove objects
-- in reverse dependency order during a supervised maintenance window.

begin;

create extension if not exists pgcrypto;
create extension if not exists supabase_vault with schema vault;

create or replace function public.black_cloud_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- The existing Black Core registry remains canonical. These columns formalize
-- whether execution is browser-local or owned by Black Cloud.
alter table public.connectivity_connections
  add column if not exists account_reference text,
  add column if not exists account_type text,
  add column if not exists market_scope jsonb not null default '[]'::jsonb,
  add column if not exists connection_mode text not null default 'LOCAL_INTERACTIVE',
  add column if not exists execution_capability text not null default 'READ_ONLY',
  add column if not exists authorization_type text,
  add column if not exists credential_version integer not null default 0,
  add column if not exists health_status text not null default 'OFFLINE',
  add column if not exists last_authenticated_at timestamptz,
  add column if not exists last_private_event_at timestamptz,
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists revoked_at timestamptz;

alter table public.connectivity_connections
  drop constraint if exists connectivity_connections_connection_mode_check,
  add constraint connectivity_connections_connection_mode_check
    check (connection_mode in ('LOCAL_INTERACTIVE','CLOUD_DELEGATED','HYBRID','DISABLED')),
  drop constraint if exists connectivity_connections_execution_capability_check,
  add constraint connectivity_connections_execution_capability_check
    check (execution_capability in ('READ_ONLY','INTERACTIVE_ONLY','CLOUD_EXECUTION','HYBRID_EXECUTION','NONE')),
  drop constraint if exists connectivity_connections_health_status_check,
  add constraint connectivity_connections_health_status_check
    check (health_status in ('CONNECTED_LOCAL','CONNECTED_CLOUD','CONNECTED_HYBRID','DEGRADED','AUTH_EXPIRED','REVOKED','OFFLINE','RECONCILING','ERROR','DISABLED')),
  drop constraint if exists connectivity_connections_market_scope_array,
  add constraint connectivity_connections_market_scope_array
    check (jsonb_typeof(market_scope) = 'array');

create index if not exists idx_connectivity_connections_cloud_health
  on public.connectivity_connections(connection_mode, health_status, last_reconciled_at)
  where revoked_at is null and disabled_at is null;

create table if not exists public.broker_connection_capabilities (
  connection_id uuid primary key references public.connectivity_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  can_read_balances boolean not null default false,
  can_read_positions boolean not null default false,
  can_read_orders boolean not null default false,
  can_place_market_orders boolean not null default false,
  can_place_limit_orders boolean not null default false,
  can_modify_orders boolean not null default false,
  can_cancel_orders boolean not null default false,
  can_place_stop_orders boolean not null default false,
  can_manage_leverage boolean not null default false,
  can_manage_margin_mode boolean not null default false,
  can_execute_while_offline boolean not null default false,
  can_copy_trade boolean not null default false,
  can_receive_group_orders boolean not null default false,
  can_withdraw boolean not null default false check (can_withdraw = false),
  supported_order_types jsonb not null default '[]'::jsonb,
  supported_market_types jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(supported_order_types) = 'array'),
  check (jsonb_typeof(supported_market_types) = 'array')
);

create table if not exists public.broker_connection_health (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  health_status text not null check (health_status in ('CONNECTED_CLOUD','DEGRADED','AUTH_EXPIRED','REVOKED','OFFLINE','RECONCILING','ERROR','DISABLED')),
  worker_id text,
  private_stream_status text,
  reconciliation_status text,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  reconnect_count integer not null default 0 check (reconnect_count >= 0),
  clock_offset_ms integer,
  last_private_event_at timestamptz,
  last_reconciled_at timestamptz,
  stale_after timestamptz,
  error_code text,
  safe_details jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create index if not exists idx_broker_connection_health_latest
  on public.broker_connection_health(connection_id, captured_at desc);

-- Secret material lives in Supabase Vault. This table contains references and
-- non-secret scope metadata only. No API key, secret, private key, ciphertext,
-- nonce, authentication tag, or wrapping key belongs in this table.
create table if not exists public.broker_secret_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  provider text not null,
  vault_secret_id uuid not null,
  credential_version integer not null default 1 check (credential_version > 0),
  credential_fingerprint text not null,
  authorization_type text not null,
  permission_scope jsonb not null default '{}'::jsonb,
  withdrawal_enabled boolean not null default false check (withdrawal_enabled = false),
  status text not null default 'ACTIVE' check (status in ('PENDING','ACTIVE','ROTATED','REVOKED','FAILED')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  unique (connection_id, credential_version)
);

create unique index if not exists idx_broker_secret_references_one_active
  on public.broker_secret_references(connection_id)
  where status = 'ACTIVE';

create table if not exists public.delegated_authorizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  wallet_address text not null,
  protocol text not null,
  delegation_type text not null,
  delegate_public_identifier text not null,
  secret_reference_id uuid references public.broker_secret_references(id) on delete set null,
  scope jsonb not null default '{}'::jsonb,
  allowed_markets jsonb not null default '[]'::jsonb,
  max_order_notional numeric check (max_order_notional is null or max_order_notional > 0),
  max_daily_notional numeric check (max_daily_notional is null or max_daily_notional > 0),
  max_leverage numeric check (max_leverage is null or max_leverage >= 1),
  expires_at timestamptz,
  revocation_reference text,
  status text not null default 'PENDING' check (status in ('PENDING','ACTIVE','EXPIRED','REVOKING','REVOKED','FAILED')),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (jsonb_typeof(allowed_markets) = 'array')
);

create index if not exists idx_delegated_authorizations_active
  on public.delegated_authorizations(connection_id, status, expires_at);

create table if not exists public.group_execution_mandates (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  broker_connection_id uuid not null references public.connectivity_connections(id) on delete restrict,
  status text not null default 'PENDING_CONSENT' check (status in ('PENDING_CONSENT','ACTIVE','PAUSED','EXPIRED','REVOKED')),
  execution_mode text not null check (execution_mode in ('LOCAL_INTERACTIVE','CLOUD_DELEGATED','HYBRID')),
  allocation_method text not null check (allocation_method in ('EQUITY_PERCENT','AVAILABLE_MARGIN_PERCENT','FIXED_NOTIONAL')),
  allocation_value numeric not null check (allocation_value > 0),
  max_order_notional numeric not null check (max_order_notional > 0),
  max_total_exposure numeric not null check (max_total_exposure > 0),
  max_daily_loss numeric not null check (max_daily_loss > 0),
  max_drawdown numeric not null check (max_drawdown > 0),
  max_leverage numeric not null check (max_leverage >= 1),
  allowed_symbols jsonb not null default '[]'::jsonb,
  allowed_market_types jsonb not null default '[]'::jsonb,
  allowed_order_types jsonb not null default '[]'::jsonb,
  allow_overnight boolean not null default false,
  allow_weekend boolean not null default false,
  allow_reduce_only boolean not null default true,
  allow_position_reversal boolean not null default false,
  protective_orders_required boolean not null default false,
  slippage_limit_bps integer not null default 50 check (slippage_limit_bps between 0 and 10000),
  mandate_version integer not null default 1 check (mandate_version > 0),
  consent_hash text,
  accepted_at timestamptz,
  expires_at timestamptz,
  paused_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, follower_user_id, broker_connection_id),
  check (jsonb_typeof(allowed_symbols) = 'array'),
  check (jsonb_typeof(allowed_market_types) = 'array'),
  check (jsonb_typeof(allowed_order_types) = 'array'),
  check (execution_mode <> 'CLOUD_DELEGATED' or accepted_at is not null or status = 'PENDING_CONSENT')
);

create index if not exists idx_group_execution_mandates_active
  on public.group_execution_mandates(group_id, status)
  where status = 'ACTIVE';
create index if not exists idx_group_execution_mandates_follower
  on public.group_execution_mandates(follower_user_id, status);

create table if not exists public.group_execution_mandate_versions (
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null references public.group_execution_mandates(id) on delete cascade,
  version integer not null check (version > 0),
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  policy_snapshot jsonb not null,
  canonical_hash text not null,
  consent_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (mandate_id, version)
);

create table if not exists public.group_trade_intents (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  strategy_id uuid references public.published_strategies(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  client_intent_id text not null,
  symbol text not null,
  market_type text not null check (market_type in ('SPOT','PERPETUAL','FUTURE','OPTION')),
  side text not null check (side in ('BUY','SELL','LONG','SHORT')),
  order_type text not null check (order_type in ('MARKET','LIMIT','CONDITIONAL','CHASE_LIMIT','TWAP','POV','ICEBERG')),
  limit_price numeric,
  stop_price numeric,
  quantity_model text not null check (quantity_model in ('MANDATE_ALLOCATION','EQUITY_PERCENT','FIXED_NOTIONAL')),
  quantity_value numeric not null check (quantity_value > 0),
  leverage numeric check (leverage is null or leverage >= 1),
  margin_mode text check (margin_mode is null or margin_mode in ('CROSS','ISOLATED')),
  time_in_force text check (time_in_force is null or time_in_force in ('GTC','IOC','FOK','POST_ONLY')),
  reduce_only boolean not null default false,
  take_profit numeric,
  stop_loss numeric,
  trailing_stop jsonb,
  valid_from timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'PENDING' check (status in ('PENDING','QUEUED','PROCESSING','PARTIALLY_DELIVERED','DELIVERED','REJECTED','CANCELLED','EXPIRED')),
  intent_version integer not null default 1 check (intent_version > 0),
  mandate_policy_version integer not null,
  canonical_hash text not null,
  service_signature text not null,
  idempotency_key text not null,
  supersedes_intent_id uuid references public.group_trade_intents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, client_intent_id),
  unique (idempotency_key),
  check (expires_at > valid_from),
  check (order_type <> 'LIMIT' or limit_price is not null),
  check (order_type <> 'CONDITIONAL' or stop_price is not null)
);

create index if not exists idx_group_trade_intents_group_time
  on public.group_trade_intents(group_id, created_at desc);
create index if not exists idx_group_trade_intents_pending
  on public.group_trade_intents(status, valid_from, expires_at)
  where status in ('PENDING','QUEUED','PROCESSING');

create table if not exists public.group_trade_intent_versions (
  id uuid primary key default gen_random_uuid(),
  group_intent_id uuid not null references public.group_trade_intents(id) on delete cascade,
  version integer not null check (version > 0),
  canonical_payload jsonb not null,
  canonical_hash text not null,
  service_signature text not null,
  amendment_type text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (group_intent_id, version)
);

create table if not exists public.follower_execution_plans (
  id uuid primary key default gen_random_uuid(),
  group_intent_id uuid not null references public.group_trade_intents(id) on delete cascade,
  mandate_id uuid not null references public.group_execution_mandates(id) on delete restrict,
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  broker_connection_id uuid not null references public.connectivity_connections(id) on delete restrict,
  execution_order_id uuid references public.execution_orders(id) on delete set null,
  calculated_equity numeric,
  calculated_available_margin numeric,
  allocation_percent numeric,
  target_notional numeric,
  rounded_quantity numeric,
  estimated_margin numeric,
  estimated_fee numeric,
  risk_result text not null default 'PENDING' check (risk_result in ('PENDING','PASSED','REJECTED')),
  rejection_reason text,
  execution_status text not null default 'PENDING' check (execution_status in ('PENDING','QUEUED','EXECUTED','WORKING','PARTIALLY_FILLED','FILLED','RISK_REJECTED','CONNECTION_UNHEALTHY','AUTH_EXPIRED','INSUFFICIENT_MARGIN','SYMBOL_NOT_ALLOWED','MANDATE_PAUSED','VENUE_REJECTED','RECONCILIATION_REQUIRED','CANCELLED')),
  idempotency_key text not null unique,
  safe_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_intent_id, mandate_id)
);

create index if not exists idx_follower_execution_plans_follower
  on public.follower_execution_plans(follower_user_id, created_at desc);
create index if not exists idx_follower_execution_plans_intent_status
  on public.follower_execution_plans(group_intent_id, execution_status);

-- Extend the canonical OMS order record for group attribution; do not create a
-- parallel order table.
alter table public.execution_orders
  add column if not exists origin text not null default 'MANUAL_BLACK_TERMINAL',
  add column if not exists group_intent_id uuid references public.group_trade_intents(id) on delete set null,
  add column if not exists mandate_id uuid references public.group_execution_mandates(id) on delete set null,
  add column if not exists actual_fees numeric not null default 0,
  add column if not exists funding_cost numeric not null default 0;

alter table public.execution_orders
  drop constraint if exists execution_orders_origin_check,
  add constraint execution_orders_origin_check
    check (origin in ('MANUAL_BLACK_TERMINAL','INVESTMENT_GROUP','EXTERNAL_VENUE','PROTECTIVE'));

create index if not exists idx_execution_orders_group_intent
  on public.execution_orders(group_intent_id, created_at desc)
  where group_intent_id is not null;

create table if not exists public.execution_commands (
  id uuid primary key default gen_random_uuid(),
  command_type text not null check (command_type in ('EXPAND_GROUP_INTENT','PLACE_ORDER','MODIFY_ORDER','CANCEL_ORDER','CANCEL_ALL','SYNC_ACCOUNT','PLACE_PROTECTION','REVOKE_CONNECTION')),
  user_id uuid references auth.users(id) on delete cascade,
  connection_id uuid references public.connectivity_connections(id) on delete cascade,
  group_intent_id uuid references public.group_trade_intents(id) on delete cascade,
  follower_plan_id uuid references public.follower_execution_plans(id) on delete cascade,
  execution_order_id uuid references public.execution_orders(id) on delete set null,
  idempotency_key text not null unique,
  deterministic_client_order_id text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'QUEUED' check (status in ('QUEUED','PROCESSING','RETRY','SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED','SUBMISSION_UNKNOWN','RECONCILING')),
  priority integer not null default 100,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 100),
  available_at timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  fencing_token bigint,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_execution_commands_claim
  on public.execution_commands(priority, available_at, created_at)
  where status in ('QUEUED','RETRY','SUBMISSION_UNKNOWN','RECONCILING');
create index if not exists idx_execution_commands_connection
  on public.execution_commands(connection_id, status, created_at);

create table if not exists public.execution_command_attempts (
  id bigint generated always as identity primary key,
  command_id uuid not null references public.execution_commands(id) on delete cascade,
  worker_id text not null,
  fencing_token bigint not null,
  attempt_number integer not null,
  outcome text not null check (outcome in ('STARTED','SUCCEEDED','RETRY','FAILED','SUBMISSION_UNKNOWN','RECONCILED')),
  provider_request_id text,
  venue_order_id text,
  safe_details jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_execution_command_attempts_command
  on public.execution_command_attempts(command_id, attempt_number desc);

create table if not exists public.worker_leases (
  lease_key text primary key,
  connection_id uuid references public.connectivity_connections(id) on delete cascade,
  worker_id text not null,
  fencing_token bigint not null default 1,
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_worker_leases_expiry
  on public.worker_leases(expires_at);

create table if not exists public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  worker_id text not null,
  trigger_type text not null check (trigger_type in ('STARTUP','RECONNECT','SCHEDULED','PRIVATE_EVENT','AMBIGUOUS_SUBMISSION','MANUAL')),
  status text not null default 'STARTED' check (status in ('STARTED','MATCHED','REPAIRED','FAILED')),
  differences jsonb not null default '[]'::jsonb,
  repairs jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text
);

create index if not exists idx_reconciliation_runs_connection
  on public.reconciliation_runs(connection_id, started_at desc);

create table if not exists public.execution_incidents (
  id uuid primary key default gen_random_uuid(),
  severity text not null check (severity in ('SEV-1','SEV-2','SEV-3')),
  incident_type text not null,
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  group_intent_id uuid references public.group_trade_intents(id) on delete set null,
  command_id uuid references public.execution_commands(id) on delete set null,
  status text not null default 'OPEN' check (status in ('OPEN','INVESTIGATING','MITIGATED','RESOLVED')),
  title text not null,
  safe_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_execution_incidents_open
  on public.execution_incidents(severity, created_at desc)
  where status <> 'RESOLVED';

create table if not exists public.execution_audit_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  group_id uuid references public.investment_groups(id) on delete set null,
  group_intent_id uuid references public.group_trade_intents(id) on delete set null,
  follower_plan_id uuid references public.follower_execution_plans(id) on delete set null,
  command_id uuid references public.execution_commands(id) on delete set null,
  worker_id text,
  event_type text not null,
  severity text not null default 'INFO' check (severity in ('INFO','WARNING','ERROR','CRITICAL')),
  operation_purpose text,
  user_visible boolean not null default true,
  message text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_execution_audit_events_user_time
  on public.execution_audit_events(user_id, created_at desc);
create index if not exists idx_execution_audit_events_intent_time
  on public.execution_audit_events(group_intent_id, created_at);
create index if not exists idx_execution_audit_events_command
  on public.execution_audit_events(command_id, created_at);

-- Material mandate changes are versioned automatically before each update.
create or replace function public.black_cloud_version_mandate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  snapshot jsonb;
begin
  if to_jsonb(old) is distinct from to_jsonb(new) then
    snapshot := to_jsonb(old) - 'updated_at';
    insert into public.group_execution_mandate_versions (
      mandate_id, version, follower_user_id, policy_snapshot, canonical_hash, consent_evidence
    ) values (
      old.id,
      old.mandate_version,
      old.follower_user_id,
      snapshot,
      encode(digest(snapshot::text, 'sha256'), 'hex'),
      jsonb_build_object('acceptedAt', old.accepted_at, 'consentHash', old.consent_hash)
    ) on conflict (mandate_id, version) do nothing;
    new.mandate_version := old.mandate_version + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_black_cloud_version_mandate on public.group_execution_mandates;
create trigger trg_black_cloud_version_mandate
before update on public.group_execution_mandates
for each row execute function public.black_cloud_version_mandate();

create or replace function public.black_cloud_prevent_immutable_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'immutable Black Cloud ledger rows cannot be updated or deleted';
end;
$$;

drop trigger if exists trg_group_trade_intent_versions_immutable on public.group_trade_intent_versions;
create trigger trg_group_trade_intent_versions_immutable
before update or delete on public.group_trade_intent_versions
for each row execute function public.black_cloud_prevent_immutable_change();

drop trigger if exists trg_execution_audit_events_immutable on public.execution_audit_events;
create trigger trg_execution_audit_events_immutable
before update or delete on public.execution_audit_events
for each row execute function public.black_cloud_prevent_immutable_change();

drop trigger if exists trg_follower_execution_plans_updated_at on public.follower_execution_plans;
create trigger trg_follower_execution_plans_updated_at before update on public.follower_execution_plans
for each row execute function public.black_cloud_set_updated_at();
drop trigger if exists trg_execution_commands_updated_at on public.execution_commands;
create trigger trg_execution_commands_updated_at before update on public.execution_commands
for each row execute function public.black_cloud_set_updated_at();
drop trigger if exists trg_delegated_authorizations_updated_at on public.delegated_authorizations;
create trigger trg_delegated_authorizations_updated_at before update on public.delegated_authorizations
for each row execute function public.black_cloud_set_updated_at();
drop trigger if exists trg_execution_incidents_updated_at on public.execution_incidents;
create trigger trg_execution_incidents_updated_at before update on public.execution_incidents
for each row execute function public.black_cloud_set_updated_at();

-- Vault RPCs are the only application path to broker secret material. They are
-- granted exclusively to service_role and record every decrypt operation.
create or replace function public.black_cloud_store_broker_secret(
  p_user_id uuid,
  p_connection_id uuid,
  p_provider text,
  p_secret jsonb,
  p_credential_fingerprint text,
  p_authorization_type text,
  p_permission_scope jsonb,
  p_withdrawal_enabled boolean default false
)
returns public.broker_secret_references
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  next_version integer;
  secret_id uuid;
  result public.broker_secret_references;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'execution service identity required' using errcode = '42501';
  end if;
  if p_withdrawal_enabled then
    raise exception 'withdrawal-enabled credentials are forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.connectivity_connections c
    where c.id = p_connection_id and c.user_id = p_user_id and c.revoked_at is null
  ) then
    raise exception 'connection ownership mismatch' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text, 0));
  select coalesce(max(credential_version), 0) + 1 into next_version
  from public.broker_secret_references where connection_id = p_connection_id;

  secret_id := vault.create_secret(
    p_secret::text,
    'black-cloud:' || p_connection_id::text || ':v' || next_version::text,
    'Black Cloud broker credential. Never expose to client roles.'
  );

  update public.broker_secret_references
  set status = 'ROTATED', rotated_at = now()
  where connection_id = p_connection_id and status = 'ACTIVE';

  insert into public.broker_secret_references (
    user_id, connection_id, provider, vault_secret_id, credential_version,
    credential_fingerprint, authorization_type, permission_scope,
    withdrawal_enabled, status, activated_at
  ) values (
    p_user_id, p_connection_id, lower(p_provider), secret_id, next_version,
    p_credential_fingerprint, p_authorization_type, coalesce(p_permission_scope, '{}'::jsonb),
    false, 'ACTIVE', now()
  ) returning * into result;

  update public.connectivity_connections
  set credential_version = next_version, authorization_type = p_authorization_type, updated_at = now()
  where id = p_connection_id;

  insert into public.execution_audit_events (
    user_id, connection_id, event_type, severity, operation_purpose, user_visible, message, safe_metadata
  ) values (
    p_user_id, p_connection_id, 'CREDENTIAL_STORED', 'INFO', 'credential_activation', true,
    'A trade-only broker authorization was stored in the managed secret vault.',
    jsonb_build_object('provider', lower(p_provider), 'credentialVersion', next_version, 'withdrawalEnabled', false)
  );
  return result;
exception when others then
  if secret_id is not null then delete from vault.secrets where id = secret_id; end if;
  raise;
end;
$$;

create or replace function public.black_cloud_read_broker_secret(
  p_secret_reference_id uuid,
  p_worker_id text,
  p_operation_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  ref public.broker_secret_references;
  plaintext text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'execution service identity required' using errcode = '42501';
  end if;
  if nullif(trim(p_worker_id), '') is null or nullif(trim(p_operation_purpose), '') is null then
    raise exception 'worker identity and operation purpose are required' using errcode = '22023';
  end if;
  select * into ref from public.broker_secret_references
  where id = p_secret_reference_id and status = 'ACTIVE' and revoked_at is null;
  if ref.id is null then raise exception 'active secret reference not found' using errcode = 'P0002'; end if;

  select decrypted_secret into plaintext
  from vault.decrypted_secrets where id = ref.vault_secret_id;
  if plaintext is null then raise exception 'vault secret not found' using errcode = 'P0002'; end if;

  update public.broker_secret_references set last_used_at = now() where id = ref.id;
  insert into public.execution_audit_events (
    user_id, connection_id, worker_id, event_type, severity,
    operation_purpose, user_visible, message, safe_metadata
  ) values (
    ref.user_id, ref.connection_id, p_worker_id, 'CREDENTIAL_DECRYPT', 'INFO',
    p_operation_purpose, false, 'Execution worker accessed a broker credential.',
    jsonb_build_object('provider', ref.provider, 'credentialVersion', ref.credential_version)
  );
  return plaintext::jsonb;
end;
$$;

create or replace function public.black_cloud_revoke_broker_secret(
  p_secret_reference_id uuid,
  p_worker_id text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  ref public.broker_secret_references;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'execution service identity required' using errcode = '42501';
  end if;
  select * into ref from public.broker_secret_references where id = p_secret_reference_id for update;
  if ref.id is null then raise exception 'secret reference not found' using errcode = 'P0002'; end if;

  update public.broker_secret_references
  set status = 'REVOKED', revoked_at = now()
  where id = ref.id;
  delete from vault.secrets where id = ref.vault_secret_id;
  update public.connectivity_connections
  set connection_mode = 'DISABLED', execution_capability = 'NONE', health_status = 'REVOKED', revoked_at = now(), updated_at = now()
  where id = ref.connection_id;
  update public.group_execution_mandates
  set status = 'PAUSED', paused_at = now(), updated_at = now()
  where broker_connection_id = ref.connection_id and status = 'ACTIVE';
  insert into public.execution_audit_events (
    user_id, connection_id, worker_id, event_type, severity, operation_purpose, message, safe_metadata
  ) values (
    ref.user_id, ref.connection_id, p_worker_id, 'CREDENTIAL_REVOKED', 'WARNING',
    'credential_revocation', 'Broker authorization was revoked and active mandates were paused.',
    jsonb_build_object('reason', left(coalesce(p_reason, 'user_requested'), 200))
  );
end;
$$;

revoke all on function public.black_cloud_store_broker_secret(uuid,uuid,text,jsonb,text,text,jsonb,boolean) from public, anon, authenticated;
revoke all on function public.black_cloud_read_broker_secret(uuid,text,text) from public, anon, authenticated;
revoke all on function public.black_cloud_revoke_broker_secret(uuid,text,text) from public, anon, authenticated;
grant execute on function public.black_cloud_store_broker_secret(uuid,uuid,text,jsonb,text,text,jsonb,boolean) to service_role;
grant execute on function public.black_cloud_read_broker_secret(uuid,text,text) to service_role;
grant execute on function public.black_cloud_revoke_broker_secret(uuid,text,text) to service_role;

-- Lease acquisition increments a fencing token on every takeover. A stale
-- worker cannot complete a command after another worker owns the connection.
create or replace function public.black_cloud_acquire_worker_lease(
  p_lease_key text,
  p_connection_id uuid,
  p_worker_id text,
  p_ttl_seconds integer default 30
)
returns public.worker_leases
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.worker_leases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'execution service identity required' using errcode = '42501';
  end if;
  if p_ttl_seconds < 5 or p_ttl_seconds > 300 then raise exception 'invalid lease ttl'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_lease_key, 0));
  select * into result from public.worker_leases where lease_key = p_lease_key for update;
  if result.lease_key is null then
    insert into public.worker_leases (
      lease_key, connection_id, worker_id, fencing_token, expires_at
    ) values (
      p_lease_key, p_connection_id, p_worker_id, 1, now() + make_interval(secs => p_ttl_seconds)
    ) returning * into result;
  elsif result.worker_id = p_worker_id or result.expires_at <= now() then
    update public.worker_leases set
      connection_id = p_connection_id,
      worker_id = p_worker_id,
      fencing_token = case when worker_id = p_worker_id then fencing_token else fencing_token + 1 end,
      acquired_at = case when worker_id = p_worker_id then acquired_at else now() end,
      heartbeat_at = now(),
      expires_at = now() + make_interval(secs => p_ttl_seconds)
    where lease_key = p_lease_key returning * into result;
  else
    return null;
  end if;
  return result;
end;
$$;

create or replace function public.black_cloud_claim_execution_commands(
  p_worker_id text,
  p_limit integer default 10,
  p_lock_seconds integer default 45
)
returns setof public.execution_commands
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'execution service identity required' using errcode = '42501';
  end if;
  return query
  with candidates as (
    select c.id
    from public.execution_commands c
    where c.status in ('QUEUED','RETRY','SUBMISSION_UNKNOWN','RECONCILING')
      and c.available_at <= now()
      and (c.locked_until is null or c.locked_until <= now())
      and c.attempt_count < c.max_attempts
    order by c.priority asc, c.available_at asc, c.created_at asc
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.execution_commands c set
    status = 'PROCESSING',
    locked_by = p_worker_id,
    locked_until = now() + make_interval(secs => greatest(10, least(p_lock_seconds, 300))),
    attempt_count = c.attempt_count + 1,
    updated_at = now()
  from candidates x where c.id = x.id
  returning c.*;
end;
$$;

create or replace function public.black_cloud_finish_execution_command(
  p_command_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_retry_after_seconds integer default null
)
returns public.execution_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  command public.execution_commands;
  lease public.worker_leases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'execution service identity required' using errcode = '42501';
  end if;
  if p_status not in ('SUCCEEDED','RETRY','FAILED','DEAD_LETTER','SUBMISSION_UNKNOWN','RECONCILING','CANCELLED') then
    raise exception 'invalid terminal command status';
  end if;
  select * into command from public.execution_commands where id = p_command_id for update;
  if command.id is null or command.locked_by <> p_worker_id then
    raise exception 'command ownership lost' using errcode = '40001';
  end if;
  select * into lease from public.worker_leases
  where lease_key = case when command.connection_id is null
    then 'global:group-intents'
    else 'connection:' || command.connection_id::text end;
  if lease.worker_id <> p_worker_id or lease.fencing_token <> p_fencing_token or lease.expires_at <= now() then
    raise exception 'stale worker fencing token' using errcode = '40001';
  end if;
  update public.execution_commands set
    status = p_status,
    fencing_token = p_fencing_token,
    last_error_code = p_error_code,
    last_error_message = left(p_error_message, 1000),
    available_at = case when p_status in ('RETRY','RECONCILING','SUBMISSION_UNKNOWN')
      then now() + make_interval(secs => greatest(1, coalesce(p_retry_after_seconds, 5))) else available_at end,
    locked_by = null,
    locked_until = null,
    completed_at = case when p_status in ('SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED') then now() else null end,
    updated_at = now()
  where id = p_command_id returning * into command;
  return command;
end;
$$;

revoke all on function public.black_cloud_acquire_worker_lease(text,uuid,text,integer) from public, anon, authenticated;
revoke all on function public.black_cloud_claim_execution_commands(text,integer,integer) from public, anon, authenticated;
revoke all on function public.black_cloud_finish_execution_command(uuid,text,bigint,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.black_cloud_acquire_worker_lease(text,uuid,text,integer) to service_role;
grant execute on function public.black_cloud_claim_execution_commands(text,integer,integer) to service_role;
grant execute on function public.black_cloud_finish_execution_command(uuid,text,bigint,text,text,text,integer) to service_role;

-- RLS: clients can see only their own safe control-plane records. Queue,
-- worker, secret, incident, and internal audit writes remain service-role only.
alter table public.broker_connection_capabilities enable row level security;
alter table public.broker_connection_health enable row level security;
alter table public.broker_secret_references enable row level security;
alter table public.delegated_authorizations enable row level security;
alter table public.group_execution_mandates enable row level security;
alter table public.group_execution_mandate_versions enable row level security;
alter table public.group_trade_intents enable row level security;
alter table public.group_trade_intent_versions enable row level security;
alter table public.follower_execution_plans enable row level security;
alter table public.execution_commands enable row level security;
alter table public.execution_command_attempts enable row level security;
alter table public.worker_leases enable row level security;
alter table public.reconciliation_runs enable row level security;
alter table public.execution_incidents enable row level security;
alter table public.execution_audit_events enable row level security;

create policy broker_connection_capabilities_select_own on public.broker_connection_capabilities
  for select using (auth.uid() = user_id);
create policy broker_connection_health_select_own on public.broker_connection_health
  for select using (auth.uid() = user_id);
create policy broker_secret_references_select_own_metadata on public.broker_secret_references
  for select using (auth.uid() = user_id);
create policy delegated_authorizations_select_own on public.delegated_authorizations
  for select using (auth.uid() = user_id);
create policy group_execution_mandates_select_own on public.group_execution_mandates
  for select using (auth.uid() = follower_user_id);
create policy group_execution_mandate_versions_select_own on public.group_execution_mandate_versions
  for select using (auth.uid() = follower_user_id);
create policy group_trade_intents_select_member on public.group_trade_intents
  for select using (
    exists (
      select 1 from public.investment_groups g
      where g.id = group_trade_intents.group_id and g.owner_user_id = auth.uid()
    ) or exists (
      select 1 from public.investment_group_members m
      where m.group_id = group_trade_intents.group_id and m.user_id = auth.uid() and m.status = 'active'
    )
  );
create policy group_trade_intent_versions_select_member on public.group_trade_intent_versions
  for select using (
    exists (select 1 from public.group_trade_intents i where i.id = group_intent_id)
  );
create policy follower_execution_plans_select_own on public.follower_execution_plans
  for select using (auth.uid() = follower_user_id);
create policy reconciliation_runs_select_own on public.reconciliation_runs
  for select using (auth.uid() = user_id);
create policy execution_incidents_select_own on public.execution_incidents
  for select using (auth.uid() = user_id);
create policy execution_audit_events_select_own_safe on public.execution_audit_events
  for select using (auth.uid() = user_id and user_visible = true);

-- Validation queries (run manually after applying):
-- select extname from pg_extension where extname in ('pgcrypto','supabase_vault');
-- select table_name from information_schema.tables where table_schema = 'public'
--   and table_name in ('group_execution_mandates','group_trade_intents','follower_execution_plans','execution_commands','worker_leases');
-- select routine_name from information_schema.routines where routine_schema = 'public'
--   and routine_name like 'black_cloud_%' order by routine_name;
-- select policyname, tablename from pg_policies where schemaname = 'public'
--   and tablename in ('broker_secret_references','execution_commands','worker_leases','execution_audit_events');

commit;
