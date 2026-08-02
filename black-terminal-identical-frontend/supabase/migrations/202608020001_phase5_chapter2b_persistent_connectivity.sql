-- Phase V, Chapter II-B: persistent connectivity restoration.
-- Extends the existing Security Fortress and Black Cloud foundation without
-- exposing secrets or granting client roles execution-table write access.
begin;

alter table public.connectivity_connections
  add column if not exists credential_state text not null default 'NONE',
  add column if not exists worker_state text not null default 'OFFLINE',
  add column if not exists synchronization_state text not null default 'NOT_SYNCHRONIZED',
  add column if not exists execution_readiness text not null default 'BLOCKED',
  add column if not exists last_account_event_at timestamptz,
  add column if not exists last_order_event_at timestamptz,
  add column if not exists last_position_sync_at timestamptz,
  add column if not exists reconnect_attempts integer not null default 0,
  add column if not exists current_lease_generation bigint,
  add column if not exists degradation_reasons jsonb not null default '[]'::jsonb;

alter table public.connectivity_connections
  drop constraint if exists connectivity_connections_credential_state_check,
  add constraint connectivity_connections_credential_state_check check (credential_state in ('NONE','SAVED','VERIFYING','AUTHENTICATED','REJECTED','REVOKED')),
  drop constraint if exists connectivity_connections_worker_state_check,
  add constraint connectivity_connections_worker_state_check check (worker_state in ('OFFLINE','STARTING','LIVE','DEGRADED','RECONNECTING','SUSPENDED','REVOKED','FAILED')),
  drop constraint if exists connectivity_connections_synchronization_state_check,
  add constraint connectivity_connections_synchronization_state_check check (synchronization_state in ('NOT_SYNCHRONIZED','SYNCHRONIZING','SYNCHRONIZED','STALE','FAILED')),
  drop constraint if exists connectivity_connections_execution_readiness_check,
  add constraint connectivity_connections_execution_readiness_check check (execution_readiness in ('BLOCKED','READ_ONLY','READY','PAUSED','REVOKED','FAILED')),
  drop constraint if exists connectivity_connections_reconnect_attempts_check,
  add constraint connectivity_connections_reconnect_attempts_check check (reconnect_attempts >= 0),
  drop constraint if exists connectivity_connections_degradation_reasons_array,
  add constraint connectivity_connections_degradation_reasons_array check (jsonb_typeof(degradation_reasons) = 'array');

create index if not exists idx_connectivity_connections_canonical_health
  on public.connectivity_connections(worker_state,synchronization_state,execution_readiness,last_heartbeat_at)
  where revoked_at is null and disabled_at is null;

-- v2 uses a random data-encryption key for each record. The server/KMS key only
-- wraps that DEK. Canonical AAD binds the envelope to its tenant and provider.
alter table public.broker_secret_vault
  add column if not exists wrapped_data_key bytea,
  add column if not exists wrapping_iv bytea,
  add column if not exists wrapping_authentication_tag bytea,
  add column if not exists associated_data_hash text,
  add column if not exists master_key_version integer not null default 1;

alter table public.broker_secret_vault
  drop constraint if exists broker_secret_vault_v2_envelope_check,
  add constraint broker_secret_vault_v2_envelope_check check (
    encryption_version = 1 or (
      encryption_version = 2 and wrapped_data_key is not null and
      octet_length(wrapping_iv) = 12 and octet_length(wrapping_authentication_tag) = 16 and
      associated_data_hash is not null and master_key_version > 0
    )
  );

create table if not exists public.broker_automation_mandates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  broker text not null,
  account_reference text not null,
  subaccount_reference text,
  allow_read boolean not null default true,
  allow_trade boolean not null default false,
  allow_cancel boolean not null default false,
  allow_modify boolean not null default false,
  allow_strategy_execution boolean not null default false,
  allow_copy_trading boolean not null default false,
  allow_investment_group_execution boolean not null default false,
  allow_withdrawals boolean not null default false check (allow_withdrawals = false),
  max_order_notional numeric check (max_order_notional is null or max_order_notional > 0),
  max_position_notional numeric check (max_position_notional is null or max_position_notional > 0),
  max_leverage numeric check (max_leverage is null or max_leverage >= 1),
  max_daily_loss numeric check (max_daily_loss is null or max_daily_loss > 0),
  allowed_strategies jsonb not null default '[]'::jsonb,
  allowed_symbols jsonb not null default '[]'::jsonb,
  emergency_policy jsonb not null default '{"preserveProtectiveOrders":true}'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING','ACTIVE','PAUSED','EXPIRED','REVOKED')),
  mandate_version integer not null default 1 check (mandate_version > 0),
  policy_version text not null,
  security_version text not null,
  canonical_hash text not null,
  service_signature text not null,
  consent_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz,
  paused_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (connection_id, mandate_version),
  check (jsonb_typeof(allowed_strategies)='array'),
  check (jsonb_typeof(allowed_symbols)='array')
);
create unique index if not exists idx_broker_automation_mandates_one_active
  on public.broker_automation_mandates(connection_id) where status='ACTIVE';
create index if not exists idx_broker_automation_mandates_user_status
  on public.broker_automation_mandates(user_id,status,expires_at);

create table if not exists public.broker_automation_mandate_versions (
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null references public.broker_automation_mandates(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  policy_snapshot jsonb not null,
  canonical_hash text not null,
  service_signature text not null,
  consent_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (mandate_id,version)
);

create table if not exists public.strategy_deployments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid,
  strategy_version text not null,
  connection_id uuid not null references public.connectivity_connections(id) on delete restrict,
  mandate_id uuid not null references public.broker_automation_mandates(id) on delete restrict,
  risk_policy_id uuid references public.account_risk_controls(account_id) on delete restrict,
  symbol text not null,
  timeframe text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','VALIDATING','DEPLOYED','RUNNING','PAUSED','DEGRADED','STOPPED','FAILED')),
  deployed_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_strategy_deployments_runtime on public.strategy_deployments(connection_id,status,last_heartbeat_at);

create table if not exists public.strategy_runtime_state (
  deployment_id uuid primary key references public.strategy_deployments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state_version bigint not null default 1,
  last_closed_candle_at timestamptz,
  last_signal_key text,
  open_position_reference text,
  indicator_state jsonb not null default '{}'::jsonb,
  protection_state jsonb not null default '{}'::jsonb,
  reconciliation_required boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.durable_execution_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  strategy_deployment_id uuid references public.strategy_deployments(id) on delete set null,
  investment_group_id uuid references public.investment_groups(id) on delete set null,
  mandate_id uuid not null references public.broker_automation_mandates(id) on delete restrict,
  idempotency_key text not null unique,
  order_request jsonb not null,
  risk_policy_version text not null,
  status text not null default 'CREATED' check (status in ('CREATED','VALIDATING','RISK_APPROVED','ROUTING','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCEL_PENDING','CANCELLED','REJECTED','EXPIRED','SUBMISSION_OUTCOME_UNKNOWN','UNKNOWN_RECONCILIATION_REQUIRED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  deterministic_client_order_id text not null,
  broker_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_durable_execution_intents_claim on public.durable_execution_intents(status,created_at)
  where status in ('CREATED','RISK_APPROVED','SUBMISSION_OUTCOME_UNKNOWN','UNKNOWN_RECONCILIATION_REQUIRED');

create table if not exists public.execution_outbox (
  id bigint generated always as identity primary key,
  intent_id uuid not null references public.durable_execution_intents(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING','CLAIMED','PUBLISHED','FAILED','DEAD_LETTER')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists idx_execution_outbox_claim on public.execution_outbox(status,available_at,id) where status in ('PENDING','FAILED');

create table if not exists public.execution_inbox (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  provider text not null,
  event_identity text not null,
  event_type text not null,
  event_at timestamptz,
  payload_hash text not null,
  status text not null default 'RECEIVED' check (status in ('RECEIVED','APPLIED','IGNORED','FAILED')),
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  error_code text,
  unique (connection_id,event_identity)
);
create index if not exists idx_execution_inbox_unapplied on public.execution_inbox(connection_id,status,received_at) where status in ('RECEIVED','FAILED');

create table if not exists public.connection_audit_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  mandate_id uuid references public.broker_automation_mandates(id) on delete set null,
  worker_id text,
  event_type text not null,
  severity text not null default 'INFO' check (severity in ('INFO','WARNING','ERROR','CRITICAL')),
  message text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_connection_audit_events_connection_time on public.connection_audit_events(connection_id,created_at desc);

create table if not exists public.investment_group_connection_assignments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete restrict,
  mandate_id uuid not null references public.broker_automation_mandates(id) on delete restrict,
  allocation_percent numeric not null check (allocation_percent > 0 and allocation_percent <= 100),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','REVOKED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id,follower_user_id,connection_id)
);

create or replace function public.black_cloud_store_encrypted_broker_secret_v2(
  p_user_id uuid, p_connection_id uuid, p_provider text,
  p_encrypted_secret bytea, p_encryption_iv bytea, p_authentication_tag bytea,
  p_wrapped_data_key bytea, p_wrapping_iv bytea, p_wrapping_authentication_tag bytea,
  p_associated_data_hash text, p_master_key_version integer,
  p_credential_fingerprint text, p_authorization_type text,
  p_permission_scope jsonb, p_withdrawal_enabled boolean default false
)
returns public.broker_secret_references
language plpgsql security definer set search_path=public
as $$
declare next_version integer; vault_id uuid := gen_random_uuid(); reference_id uuid := gen_random_uuid(); result public.broker_secret_references;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  if p_withdrawal_enabled then raise exception 'withdrawal-enabled credentials are forbidden' using errcode='42501'; end if;
  if not exists(select 1 from public.connectivity_connections where id=p_connection_id and user_id=p_user_id and revoked_at is null) then raise exception 'connection ownership mismatch' using errcode='42501'; end if;
  if octet_length(p_encryption_iv)<>12 or octet_length(p_authentication_tag)<>16 or octet_length(p_wrapping_iv)<>12 or octet_length(p_wrapping_authentication_tag)<>16 then raise exception 'invalid AES-GCM envelope' using errcode='22023'; end if;
  if octet_length(p_wrapped_data_key)<>32 or p_master_key_version<1 or length(p_associated_data_hash)<>64 then raise exception 'invalid wrapped data key' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text,0));
  select coalesce(max(credential_version),0)+1 into next_version from public.broker_secret_references where connection_id=p_connection_id;
  update public.broker_secret_references set status='ROTATED',rotated_at=now() where connection_id=p_connection_id and status='ACTIVE';
  update public.broker_secret_vault set rotation_status='ROTATED',rotated_at=now() where connection_id=p_connection_id and rotation_status='ACTIVE';
  insert into public.broker_secret_vault(id,secret_reference_id,user_id,connection_id,provider,encrypted_secret,encryption_iv,authentication_tag,encryption_version,rotation_status,wrapped_data_key,wrapping_iv,wrapping_authentication_tag,associated_data_hash,master_key_version)
  values(vault_id,reference_id,p_user_id,p_connection_id,lower(p_provider),p_encrypted_secret,p_encryption_iv,p_authentication_tag,2,'ACTIVE',p_wrapped_data_key,p_wrapping_iv,p_wrapping_authentication_tag,p_associated_data_hash,p_master_key_version);
  insert into public.broker_secret_references(id,user_id,connection_id,provider,vault_secret_id,credential_version,credential_fingerprint,authorization_type,permission_scope,withdrawal_enabled,status,activated_at)
  values(reference_id,p_user_id,p_connection_id,lower(p_provider),vault_id,next_version,p_credential_fingerprint,p_authorization_type,coalesce(p_permission_scope,'{}'::jsonb),false,'ACTIVE',now()) returning * into result;
  update public.connectivity_connections set credential_version=next_version,credential_state='SAVED',authorization_type=p_authorization_type,updated_at=now() where id=p_connection_id and user_id=p_user_id;
  insert into public.connection_audit_events(user_id,connection_id,event_type,message,safe_metadata) values(p_user_id,p_connection_id,case when next_version=1 then 'CREDENTIAL_CREATED' else 'CREDENTIAL_ROTATED' end,'A versioned trade-only credential envelope was activated.',jsonb_build_object('provider',lower(p_provider),'credentialVersion',next_version,'masterKeyVersion',p_master_key_version));
  return result;
end;
$$;

create or replace function public.black_cloud_assert_current_fencing_token(p_connection_id uuid,p_worker_id text,p_fencing_token bigint)
returns boolean language plpgsql security definer set search_path=public as $$
declare lease public.worker_leases;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  select * into lease from public.worker_leases where lease_key='connection:'||p_connection_id::text;
  if lease.lease_key is null or lease.worker_id<>p_worker_id or lease.fencing_token<>p_fencing_token or lease.expires_at<=now() then raise exception 'stale worker fencing token' using errcode='40001'; end if;
  return true;
end;
$$;

create or replace function public.black_cloud_activate_automation_mandate(
  p_user_id uuid, p_connection_id uuid, p_policy jsonb,
  p_canonical_hash text, p_service_signature text, p_consent_evidence jsonb
)
returns public.broker_automation_mandates
language plpgsql security definer set search_path=public
as $$
declare
  next_version integer;
  expected_version integer;
  result public.broker_automation_mandates;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  if not exists(select 1 from public.connectivity_connections where id=p_connection_id and user_id=p_user_id and revoked_at is null and disabled_at is null) then raise exception 'connection ownership mismatch' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowWithdrawals')::boolean,false) then raise exception 'withdrawal automation is forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mandate:'||p_connection_id::text,0));
  select coalesce(max(mandate_version),0)+1 into next_version from public.broker_automation_mandates where connection_id=p_connection_id;
  expected_version := (p_policy->>'mandateVersion')::integer;
  if expected_version is distinct from next_version then raise exception 'automation mandate version conflict' using errcode='40001'; end if;
  update public.broker_automation_mandates set status='REVOKED',revoked_at=now(),updated_at=now() where connection_id=p_connection_id and status='ACTIVE';
  insert into public.broker_automation_mandates(
    user_id,connection_id,broker,account_reference,subaccount_reference,
    allow_read,allow_trade,allow_cancel,allow_modify,allow_strategy_execution,
    allow_copy_trading,allow_investment_group_execution,allow_withdrawals,
    max_order_notional,max_position_notional,max_leverage,max_daily_loss,
    allowed_strategies,allowed_symbols,emergency_policy,status,mandate_version,
    policy_version,security_version,canonical_hash,service_signature,
    consent_evidence,accepted_at,expires_at
  ) values (
    p_user_id,p_connection_id,lower(p_policy->>'broker'),p_policy->>'accountReference',nullif(p_policy->>'subaccountReference',''),
    coalesce((p_policy->>'allowRead')::boolean,true),coalesce((p_policy->>'allowTrade')::boolean,false),
    coalesce((p_policy->>'allowCancel')::boolean,false),coalesce((p_policy->>'allowModify')::boolean,false),
    coalesce((p_policy->>'allowStrategyExecution')::boolean,false),coalesce((p_policy->>'allowCopyTrading')::boolean,false),
    coalesce((p_policy->>'allowInvestmentGroupExecution')::boolean,false),false,
    nullif(p_policy->>'maxOrderNotional','')::numeric,nullif(p_policy->>'maxPositionNotional','')::numeric,
    nullif(p_policy->>'maxLeverage','')::numeric,nullif(p_policy->>'maxDailyLoss','')::numeric,
    coalesce(p_policy->'allowedStrategies','[]'::jsonb),coalesce(p_policy->'allowedSymbols','[]'::jsonb),
    coalesce(p_policy->'emergencyPolicy','{"preserveProtectiveOrders":true}'::jsonb),'ACTIVE',next_version,
    p_policy->>'policyVersion',p_policy->>'securityVersion',p_canonical_hash,p_service_signature,
    coalesce(p_consent_evidence,'{}'::jsonb),(p_policy->>'acceptedAt')::timestamptz,nullif(p_policy->>'expiresAt','')::timestamptz
  ) returning * into result;
  insert into public.broker_automation_mandate_versions(mandate_id,user_id,version,policy_snapshot,canonical_hash,service_signature,consent_evidence)
  values(result.id,p_user_id,next_version,p_policy,p_canonical_hash,p_service_signature,coalesce(p_consent_evidence,'{}'::jsonb));
  insert into public.connection_audit_events(user_id,connection_id,mandate_id,event_type,message,safe_metadata)
  values(p_user_id,p_connection_id,result.id,'AUTOMATION_MANDATE_AUTHORIZED','The user explicitly authorized bounded browser-independent execution.',jsonb_build_object('version',next_version,'withdrawalPermission',false,'expiresAt',result.expires_at));
  return result;
end;
$$;

revoke all on function public.black_cloud_store_encrypted_broker_secret_v2(uuid,uuid,text,bytea,bytea,bytea,bytea,bytea,bytea,text,integer,text,text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.black_cloud_assert_current_fencing_token(uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.black_cloud_activate_automation_mandate(uuid,uuid,jsonb,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.black_cloud_store_encrypted_broker_secret_v2(uuid,uuid,text,bytea,bytea,bytea,bytea,bytea,bytea,text,integer,text,text,jsonb,boolean) to service_role;
grant execute on function public.black_cloud_assert_current_fencing_token(uuid,text,bigint) to service_role;
grant execute on function public.black_cloud_activate_automation_mandate(uuid,uuid,jsonb,text,text,jsonb) to service_role;

alter table public.broker_automation_mandates enable row level security;
alter table public.broker_automation_mandate_versions enable row level security;
alter table public.strategy_deployments enable row level security;
alter table public.strategy_runtime_state enable row level security;
alter table public.durable_execution_intents enable row level security;
alter table public.execution_outbox enable row level security;
alter table public.execution_inbox enable row level security;
alter table public.connection_audit_events enable row level security;
alter table public.investment_group_connection_assignments enable row level security;

revoke all on public.execution_outbox,public.execution_inbox from anon,authenticated;
create policy broker_automation_mandates_select_own on public.broker_automation_mandates for select using(auth.uid()=user_id);
create policy broker_automation_mandate_versions_select_own on public.broker_automation_mandate_versions for select using(auth.uid()=user_id);
create policy strategy_deployments_select_own on public.strategy_deployments for select using(auth.uid()=user_id);
create policy strategy_runtime_state_select_own on public.strategy_runtime_state for select using(auth.uid()=user_id);
create policy durable_execution_intents_select_own on public.durable_execution_intents for select using(auth.uid()=user_id);
create policy connection_audit_events_select_own on public.connection_audit_events for select using(auth.uid()=user_id);
create policy investment_group_connection_assignments_select_own on public.investment_group_connection_assignments for select using(auth.uid()=follower_user_id);

drop trigger if exists trg_connection_audit_events_immutable on public.connection_audit_events;
create trigger trg_connection_audit_events_immutable before update or delete on public.connection_audit_events for each row execute function public.black_cloud_prevent_immutable_change();
drop trigger if exists trg_broker_automation_mandate_versions_immutable on public.broker_automation_mandate_versions;
create trigger trg_broker_automation_mandate_versions_immutable before update or delete on public.broker_automation_mandate_versions for each row execute function public.black_cloud_prevent_immutable_change();

commit;
