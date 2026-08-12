-- Phase V, Chapter II-C: Bybit Demo/Mainnet Live production activation.
-- The active certification path is explicitly environment-bound. Legacy
-- Testnet account rows remain readable but cannot be activated by this chapter.
begin;

alter table public.exchange_accounts
  add column if not exists execution_environment text,
  add column if not exists endpoint_profile text,
  add column if not exists broker_account_uid text,
  add column if not exists permission_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists permission_verified_at timestamptz;

update public.exchange_accounts
set execution_environment='MAINNET_LIVE', endpoint_profile=coalesce(endpoint_profile,'GLOBAL')
where exchange='bybit' and network='mainnet' and execution_environment is null;

alter table public.exchange_accounts
  drop constraint if exists exchange_accounts_network_check,
  add constraint exchange_accounts_network_check check (network in ('mainnet','demo','testnet')),
  drop constraint if exists exchange_accounts_execution_environment_check,
  add constraint exchange_accounts_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE')),
  drop constraint if exists exchange_accounts_permission_snapshot_object,
  add constraint exchange_accounts_permission_snapshot_object check (jsonb_typeof(permission_snapshot)='object');

create index if not exists idx_exchange_accounts_certification_environment
  on public.exchange_accounts(user_id,exchange,execution_environment,endpoint_profile);

alter table public.connectivity_connections
  add column if not exists execution_environment text,
  add column if not exists endpoint_profile text,
  add column if not exists broker_account_uid text,
  add column if not exists permission_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists certification_state text not null default 'NOT_STARTED';

alter table public.connectivity_connections
  drop constraint if exists connectivity_connections_execution_environment_check,
  add constraint connectivity_connections_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE')),
  drop constraint if exists connectivity_connections_permission_snapshot_object,
  add constraint connectivity_connections_permission_snapshot_object check (jsonb_typeof(permission_snapshot)='object'),
  drop constraint if exists connectivity_connections_certification_state_check,
  add constraint connectivity_connections_certification_state_check check (certification_state in ('NOT_STARTED','ENDPOINT_VERIFIED','UID_VERIFIED','PERMISSIONS_VERIFIED','SYNCHRONIZING','READY','CANARY_ARMED','CANARY_SUBMITTED','CANARY_VERIFIED','DEGRADED','FAILED','REVOKED'));

create index if not exists idx_connectivity_connections_environment_readiness
  on public.connectivity_connections(execution_environment,worker_state,synchronization_state,execution_readiness)
  where revoked_at is null and disabled_at is null;

alter table public.broker_secret_references
  add column if not exists execution_environment text,
  add column if not exists permission_snapshot jsonb not null default '{}'::jsonb;

alter table public.broker_secret_references
  drop constraint if exists broker_secret_references_execution_environment_check,
  add constraint broker_secret_references_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE')),
  drop constraint if exists broker_secret_references_permission_snapshot_object,
  add constraint broker_secret_references_permission_snapshot_object check (jsonb_typeof(permission_snapshot)='object');

alter table public.broker_secret_vault
  add column if not exists execution_environment text,
  add column if not exists credential_version integer;

alter table public.broker_secret_vault
  drop constraint if exists broker_secret_vault_execution_environment_check,
  add constraint broker_secret_vault_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE')),
  drop constraint if exists broker_secret_vault_v2_envelope_check,
  add constraint broker_secret_vault_v2_envelope_check check (
    encryption_version = 1 or (
      encryption_version = 2 and wrapped_data_key is not null and
      octet_length(wrapping_iv)=12 and octet_length(wrapping_authentication_tag)=16 and
      associated_data_hash is not null and master_key_version>0
    ) or (
      encryption_version = 3 and wrapped_data_key is not null and
      octet_length(wrapping_iv)=12 and octet_length(wrapping_authentication_tag)=16 and
      associated_data_hash is not null and master_key_version>0 and
      execution_environment in ('DEMO','MAINNET_LIVE') and credential_version>0
    )
  );

alter table public.broker_automation_mandates
  add column if not exists execution_environment text,
  add column if not exists risk_policy_version integer not null default 1;

alter table public.broker_automation_mandates
  drop constraint if exists broker_automation_mandates_execution_environment_check,
  add constraint broker_automation_mandates_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE')),
  drop constraint if exists broker_automation_mandates_risk_policy_version_check,
  add constraint broker_automation_mandates_risk_policy_version_check check (risk_policy_version>0);

alter table public.strategy_deployments
  add column if not exists execution_environment text;
alter table public.strategy_deployments
  drop constraint if exists strategy_deployments_execution_environment_check,
  add constraint strategy_deployments_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE'));

alter table public.durable_execution_intents
  add column if not exists execution_environment text;
alter table public.durable_execution_intents
  drop constraint if exists durable_execution_intents_execution_environment_check,
  add constraint durable_execution_intents_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE'));

create table if not exists public.broker_risk_policy_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  mandate_id uuid references public.broker_automation_mandates(id) on delete set null,
  execution_environment text not null check (execution_environment in ('DEMO','MAINNET_LIVE')),
  policy_version integer not null check (policy_version>0),
  policy_snapshot jsonb not null,
  canonical_hash text not null,
  service_signature text not null,
  confirmation_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(connection_id,policy_version),
  check (jsonb_typeof(policy_snapshot)='object')
);

create index if not exists idx_broker_risk_policy_versions_connection
  on public.broker_risk_policy_versions(connection_id,policy_version desc);
alter table public.broker_risk_policy_versions enable row level security;
revoke all on public.broker_risk_policy_versions from anon,authenticated;
grant select on public.broker_risk_policy_versions to authenticated;
create policy broker_risk_policy_versions_select_own on public.broker_risk_policy_versions
  for select using(auth.uid()=user_id);
drop trigger if exists trg_broker_risk_policy_versions_immutable on public.broker_risk_policy_versions;
create trigger trg_broker_risk_policy_versions_immutable before update or delete on public.broker_risk_policy_versions
  for each row execute function public.black_cloud_prevent_immutable_change();

create or replace function public.black_cloud_store_encrypted_broker_secret_v3(
  p_user_id uuid, p_connection_id uuid, p_provider text,
  p_execution_environment text, p_expected_credential_version integer,
  p_encrypted_secret bytea, p_encryption_iv bytea, p_authentication_tag bytea,
  p_wrapped_data_key bytea, p_wrapping_iv bytea, p_wrapping_authentication_tag bytea,
  p_associated_data_hash text, p_master_key_version integer,
  p_credential_fingerprint text, p_authorization_type text,
  p_permission_scope jsonb, p_permission_snapshot jsonb,
  p_withdrawal_enabled boolean default false
)
returns public.broker_secret_references
language plpgsql security definer set search_path=public
as $$
declare
  next_version integer;
  vault_id uuid := gen_random_uuid();
  reference_id uuid := gen_random_uuid();
  result public.broker_secret_references;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  if p_execution_environment not in ('DEMO','MAINNET_LIVE') then raise exception 'invalid execution environment' using errcode='22023'; end if;
  if p_withdrawal_enabled or coalesce((p_permission_snapshot->>'withdrawal')::boolean,false) then raise exception 'withdrawal-enabled credentials are forbidden' using errcode='42501'; end if;
  if coalesce((p_permission_snapshot->>'walletTransfer')::boolean,false) then raise exception 'wallet-transfer-enabled credentials are forbidden' using errcode='42501'; end if;
  if not exists(
    select 1 from public.connectivity_connections
    where id=p_connection_id and user_id=p_user_id and revoked_at is null
      and execution_environment=p_execution_environment
  ) then raise exception 'connection ownership or environment mismatch' using errcode='42501'; end if;
  if octet_length(p_encryption_iv)<>12 or octet_length(p_authentication_tag)<>16 or octet_length(p_wrapping_iv)<>12 or octet_length(p_wrapping_authentication_tag)<>16 then raise exception 'invalid AES-GCM envelope' using errcode='22023'; end if;
  if octet_length(p_wrapped_data_key)<>32 or p_master_key_version<1 or length(p_associated_data_hash)<>64 then raise exception 'invalid wrapped data key' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text,0));
  select coalesce(max(credential_version),0)+1 into next_version from public.broker_secret_references where connection_id=p_connection_id;
  if p_expected_credential_version is distinct from next_version then raise exception 'credential version conflict' using errcode='40001'; end if;
  update public.broker_secret_references set status='ROTATED',rotated_at=now() where connection_id=p_connection_id and status='ACTIVE';
  update public.broker_secret_vault set rotation_status='ROTATED',rotated_at=now() where connection_id=p_connection_id and rotation_status='ACTIVE';
  insert into public.broker_secret_vault(
    id,secret_reference_id,user_id,connection_id,provider,execution_environment,credential_version,
    encrypted_secret,encryption_iv,authentication_tag,encryption_version,rotation_status,
    wrapped_data_key,wrapping_iv,wrapping_authentication_tag,associated_data_hash,master_key_version
  ) values(
    vault_id,reference_id,p_user_id,p_connection_id,lower(p_provider),p_execution_environment,next_version,
    p_encrypted_secret,p_encryption_iv,p_authentication_tag,3,'ACTIVE',
    p_wrapped_data_key,p_wrapping_iv,p_wrapping_authentication_tag,p_associated_data_hash,p_master_key_version
  );
  insert into public.broker_secret_references(
    id,user_id,connection_id,provider,execution_environment,vault_secret_id,credential_version,
    credential_fingerprint,authorization_type,permission_scope,permission_snapshot,withdrawal_enabled,status,activated_at
  ) values(
    reference_id,p_user_id,p_connection_id,lower(p_provider),p_execution_environment,vault_id,next_version,
    p_credential_fingerprint,p_authorization_type,coalesce(p_permission_scope,'{}'::jsonb),coalesce(p_permission_snapshot,'{}'::jsonb),false,'ACTIVE',now()
  ) returning * into result;
  update public.connectivity_connections set
    credential_version=next_version,credential_state='SAVED',authorization_type=p_authorization_type,
    permission_snapshot=coalesce(p_permission_snapshot,'{}'::jsonb),certification_state='PERMISSIONS_VERIFIED',updated_at=now()
  where id=p_connection_id and user_id=p_user_id and execution_environment=p_execution_environment;
  insert into public.connection_audit_events(user_id,connection_id,event_type,message,safe_metadata)
  values(p_user_id,p_connection_id,case when next_version=1 then 'CREDENTIAL_CREATED' else 'CREDENTIAL_ROTATED' end,
    'An environment-bound trade-only credential envelope was activated.',
    jsonb_build_object('provider',lower(p_provider),'executionEnvironment',p_execution_environment,'credentialVersion',next_version,'masterKeyVersion',p_master_key_version));
  return result;
end;
$$;

revoke all on function public.black_cloud_store_encrypted_broker_secret_v3(uuid,uuid,text,text,integer,bytea,bytea,bytea,bytea,bytea,bytea,text,integer,text,text,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.black_cloud_store_encrypted_broker_secret_v3(uuid,uuid,text,text,integer,bytea,bytea,bytea,bytea,bytea,bytea,text,integer,text,text,jsonb,jsonb,boolean) to service_role;

create or replace function public.black_cloud_activate_automation_mandate_v2(
  p_user_id uuid, p_connection_id uuid, p_policy jsonb,
  p_canonical_hash text, p_service_signature text, p_consent_evidence jsonb,
  p_risk_policy jsonb, p_risk_canonical_hash text, p_risk_service_signature text
)
returns public.broker_automation_mandates
language plpgsql security definer set search_path=public
as $$
declare
  next_version integer;
  next_risk_version integer;
  expected_version integer;
  expected_risk_version integer;
  environment text;
  result public.broker_automation_mandates;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  environment := p_policy->>'executionEnvironment';
  if environment not in ('DEMO','MAINNET_LIVE') then raise exception 'invalid execution environment' using errcode='22023'; end if;
  if not exists(
    select 1 from public.connectivity_connections
    where id=p_connection_id and user_id=p_user_id and revoked_at is null and disabled_at is null
      and execution_environment=environment
  ) then raise exception 'connection ownership or environment mismatch' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowWithdrawals')::boolean,false) then raise exception 'withdrawal automation is forbidden' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowTransfers')::boolean,false) then raise exception 'wallet transfer automation is forbidden' using errcode='42501'; end if;
  if coalesce(p_consent_evidence->>'executionEnvironment','')<>environment then raise exception 'consent environment mismatch' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('mandate:'||p_connection_id::text,0));
  select coalesce(max(mandate_version),0)+1 into next_version from public.broker_automation_mandates where connection_id=p_connection_id;
  select coalesce(max(policy_version),0)+1 into next_risk_version from public.broker_risk_policy_versions where connection_id=p_connection_id;
  expected_version := (p_policy->>'mandateVersion')::integer;
  expected_risk_version := (p_policy->>'riskPolicyVersion')::integer;
  if expected_version is distinct from next_version then raise exception 'automation mandate version conflict' using errcode='40001'; end if;
  if expected_risk_version is distinct from next_risk_version then raise exception 'risk policy version conflict' using errcode='40001'; end if;
  update public.broker_automation_mandates set status='REVOKED',revoked_at=now(),updated_at=now() where connection_id=p_connection_id and status='ACTIVE';
  insert into public.broker_automation_mandates(
    user_id,connection_id,broker,account_reference,subaccount_reference,
    allow_read,allow_trade,allow_cancel,allow_modify,allow_strategy_execution,
    allow_copy_trading,allow_investment_group_execution,allow_withdrawals,
    max_order_notional,max_position_notional,max_leverage,max_daily_loss,
    allowed_strategies,allowed_symbols,emergency_policy,status,mandate_version,
    policy_version,security_version,canonical_hash,service_signature,
    consent_evidence,accepted_at,expires_at,execution_environment,risk_policy_version
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
    coalesce(p_consent_evidence,'{}'::jsonb),(p_policy->>'acceptedAt')::timestamptz,nullif(p_policy->>'expiresAt','')::timestamptz,
    environment,next_risk_version
  ) returning * into result;
  insert into public.broker_automation_mandate_versions(mandate_id,user_id,version,policy_snapshot,canonical_hash,service_signature,consent_evidence)
  values(result.id,p_user_id,next_version,p_policy,p_canonical_hash,p_service_signature,coalesce(p_consent_evidence,'{}'::jsonb));
  insert into public.broker_risk_policy_versions(
    user_id,connection_id,mandate_id,execution_environment,policy_version,
    policy_snapshot,canonical_hash,service_signature,confirmation_evidence
  ) values (
    p_user_id,p_connection_id,result.id,environment,next_risk_version,
    p_risk_policy,p_risk_canonical_hash,p_risk_service_signature,coalesce(p_consent_evidence,'{}'::jsonb)
  );
  insert into public.connection_audit_events(user_id,connection_id,mandate_id,event_type,message,safe_metadata)
  values(
    p_user_id,p_connection_id,result.id,'AUTOMATION_MANDATE_AUTHORIZED',
    'The user explicitly authorized environment-bound browser-independent execution.',
    jsonb_build_object('version',next_version,'riskPolicyVersion',next_risk_version,'executionEnvironment',environment,'withdrawalPermission',false,'transferPermission',false,'expiresAt',result.expires_at)
  );
  return result;
end;
$$;

revoke all on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) to service_role;

commit;
