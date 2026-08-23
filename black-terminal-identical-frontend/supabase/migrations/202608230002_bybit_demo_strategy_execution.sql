-- Bybit Demo Trading strategy execution. This migration deliberately does not
-- enable real-funds MAINNET_LIVE automation. Demo execution uses Bybit's
-- api-demo venue while public market data remains on the mainnet public feed.
begin;

alter table public.execution_orders
  drop constraint if exists execution_orders_origin_check;
alter table public.execution_orders
  add constraint execution_orders_origin_check check (
    origin in ('MANUAL_BLACK_TERMINAL','INVESTMENT_GROUP','STRATEGY_AUTOMATION_DEMO','EXTERNAL_VENUE','PROTECTIVE')
  );

alter table public.execution_commands
  add column if not exists strategy_automation_id uuid references public.strategy_automation_strategies(id) on delete cascade,
  add column if not exists strategy_target_binding_id uuid references public.strategy_target_bindings(id) on delete cascade,
  add column if not exists strategy_signal_key text;

alter table public.execution_commands
  drop constraint if exists execution_commands_strategy_shape_check;
alter table public.execution_commands
  add constraint execution_commands_strategy_shape_check check (
    (strategy_target_binding_id is null and strategy_automation_id is null and strategy_signal_key is null)
    or
    (command_type='PLACE_ORDER' and strategy_target_binding_id is not null and strategy_automation_id is not null and length(strategy_signal_key) between 16 and 512)
  );

create unique index if not exists idx_execution_commands_strategy_signal
  on public.execution_commands(strategy_target_binding_id,strategy_signal_key)
  where strategy_target_binding_id is not null;
create index if not exists idx_execution_commands_strategy_status
  on public.execution_commands(strategy_automation_id,status,created_at desc)
  where strategy_automation_id is not null;

-- Until position attribution supports multi-strategy netting, a demo broker
-- account may have only one armed strategy. This avoids misleading ownership
-- and prevents two strategies from racing the same venue position.
create unique index if not exists idx_strategy_target_one_live_per_account
  on public.strategy_target_bindings(account_id)
  where account_id is not null and status='LIVE';

-- Replace the obsolete phrase-gated Mainnet mandate RPC with a server-signed,
-- Demo-only activation contract. The browser cannot choose the environment and
-- authenticated clients cannot execute this function directly.
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
  if environment <> 'DEMO' then raise exception 'Strategy Lab automation requires Bybit Demo Trading' using errcode='22023'; end if;
  if not exists(
    select 1 from public.connectivity_connections
    where id=p_connection_id and user_id=p_user_id and revoked_at is null and disabled_at is null
      and provider='bybit' and execution_environment='DEMO' and endpoint_profile='GLOBAL'
  ) then raise exception 'connection ownership or locked demo environment mismatch' using errcode='42501'; end if;
  if not exists(
    select 1 from public.broker_connection_capabilities
    where connection_id=p_connection_id and can_place_market_orders is true
      and can_execute_while_offline is true and can_withdraw is false and can_transfer is false
  ) then raise exception 'safe demo execution capabilities are incomplete' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowWithdrawals')::boolean,false) then raise exception 'withdrawal automation is forbidden' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowTransfers')::boolean,false) then raise exception 'wallet transfer automation is forbidden' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowStrategyExecution')::boolean,false) is not true then raise exception 'strategy execution authority is required' using errcode='22023'; end if;
  if coalesce((p_policy->>'allowCopyTrading')::boolean,false) or coalesce((p_policy->>'allowInvestmentGroupExecution')::boolean,false) then
    raise exception 'Strategy Lab demo activation cannot authorize copy or group execution' using errcode='42501';
  end if;
  if coalesce(p_consent_evidence->>'executionEnvironment','') <> environment then raise exception 'consent environment mismatch' using errcode='42501'; end if;
  if coalesce(p_consent_evidence->>'action','') <> 'ACTIVATE_BYBIT_DEMO_STRATEGY_EXECUTION' then raise exception 'demo strategy activation evidence missing' using errcode='42501'; end if;
  if coalesce((p_consent_evidence->>'persistentAfterLogout')::boolean,false) is not true then raise exception 'persistent execution evidence missing' using errcode='42501'; end if;
  if length(coalesce(p_canonical_hash,'')) <> 64 or length(coalesce(p_risk_canonical_hash,'')) <> 64 then raise exception 'canonical policy hash invalid' using errcode='22023'; end if;
  if length(coalesce(p_service_signature,'')) < 32 or length(coalesce(p_risk_service_signature,'')) < 32 then raise exception 'service signature invalid' using errcode='22023'; end if;
  if nullif(p_policy->>'expiresAt','') is not null and (p_policy->>'expiresAt')::timestamptz <= now() then raise exception 'automation mandate has expired' using errcode='22023'; end if;
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
    true,true,true,true,true,false,false,false,
    nullif(p_policy->>'maxOrderNotional','')::numeric,nullif(p_policy->>'maxPositionNotional','')::numeric,
    nullif(p_policy->>'maxLeverage','')::numeric,nullif(p_policy->>'maxDailyLoss','')::numeric,
    coalesce(p_policy->'allowedStrategies','[]'::jsonb),coalesce(p_policy->'allowedSymbols','[]'::jsonb),
    coalesce(p_policy->'emergencyPolicy','{"preserveProtectiveOrders":true}'::jsonb),'ACTIVE',next_version,
    p_policy->>'policyVersion',p_policy->>'securityVersion',p_canonical_hash,p_service_signature,
    p_consent_evidence,(p_policy->>'acceptedAt')::timestamptz,nullif(p_policy->>'expiresAt','')::timestamptz,
    environment,next_risk_version
  ) returning * into result;
  insert into public.broker_automation_mandate_versions(mandate_id,user_id,version,policy_snapshot,canonical_hash,service_signature,consent_evidence)
  values(result.id,p_user_id,next_version,p_policy,p_canonical_hash,p_service_signature,p_consent_evidence);
  insert into public.broker_risk_policy_versions(
    user_id,connection_id,mandate_id,execution_environment,policy_version,
    policy_snapshot,canonical_hash,service_signature,confirmation_evidence
  ) values (
    p_user_id,p_connection_id,result.id,environment,next_risk_version,
    p_risk_policy,p_risk_canonical_hash,p_risk_service_signature,p_consent_evidence
  );
  insert into public.connection_audit_events(user_id,connection_id,mandate_id,event_type,message,safe_metadata)
  values(
    p_user_id,p_connection_id,result.id,'DEMO_STRATEGY_AUTOMATION_AUTHORIZED',
    'The user activated persistent strategy execution on a Bybit Demo Trading account.',
    jsonb_build_object('version',next_version,'riskPolicyVersion',next_risk_version,'executionEnvironment',environment,'simulatedFunds',true,'withdrawalPermission',false,'transferPermission',false,'expiresAt',result.expires_at)
  );
  return result;
end;
$$;

revoke all on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) to service_role;

-- A version handoff may not orphan an open broker position. Flat old targets
-- are paused atomically in the same transaction that starts the new version.
create or replace function public.black_core_start_strategy_version(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_version integer
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  strategy_row public.strategy_automation_strategies;
  version_row public.strategy_automation_versions;
  old_paper uuid;
  open_paper_count integer;
  open_broker_count integer;
  armed_old_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-start-version:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  select * into version_row from public.strategy_automation_versions where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id and version=p_version;
  if version_row.id is null then raise exception 'strategy version missing' using errcode='22023'; end if;
  if strategy_row.running_version is not null and strategy_row.running_version<>p_version then
    select id into old_paper from public.strategy_paper_accounts where strategy_id=p_strategy_id and strategy_version=strategy_row.running_version;
    select count(*) into open_paper_count from public.strategy_paper_positions where paper_account_id=old_paper and closed_at is null;
    if open_paper_count>0 then raise exception 'running paper version has an open position' using errcode='55000'; end if;
    select count(*) into open_broker_count
      from public.account_positions p join public.strategy_target_bindings b on b.id=p.strategy_target_binding_id
      where b.strategy_id=p_strategy_id and b.strategy_version=strategy_row.running_version
        and b.owner_user_id=p_owner_user_id and b.status<>'DISCONNECTED' and p.quantity>0;
    if open_broker_count>0 then raise exception 'running broker version has an open strategy position' using errcode='55000'; end if;
    update public.strategy_target_bindings set status='PAUSED',paused_at=now(),row_version=row_version+1
      where strategy_id=p_strategy_id and strategy_version=strategy_row.running_version and owner_user_id=p_owner_user_id and status='LIVE';
    get diagnostics armed_old_count = row_count;
  end if;
  update public.strategy_paper_accounts set status='PAUSED' where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id and strategy_version<>p_version and status='ACTIVE';
  update public.strategy_paper_accounts set status='ACTIVE' where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id and strategy_version=p_version;
  if not found then raise exception 'paper target missing for strategy version' using errcode='22023'; end if;
  update public.strategy_automation_strategies set running_version=p_version,status='PAPER_ACTIVE' where id=p_strategy_id;
  insert into public.strategy_automation_runtime_state(strategy_id,owner_user_id,runtime_state,running_version)
  values(p_strategy_id,p_owner_user_id,'STARTING',p_version)
  on conflict(strategy_id) do update set runtime_state='STARTING',running_version=excluded.running_version,state_version=public.strategy_automation_runtime_state.state_version+1,
    last_closed_candle_at=null,last_signal_key=null,last_signal_at=null,last_heartbeat_at=null,worker_id=null,lease_owner=null,lease_expires_at=null,safe_error_code=null;
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'STRATEGY_RUNTIME_VERSION_STARTED','The selected private configuration became the active runtime after a flat, paused target handoff.',
    jsonb_build_object('previousVersion',strategy_row.running_version,'runningVersion',p_version,'pausedOldDemoTargets',coalesce(armed_old_count,0),'simulatedFunds',true));
  return jsonb_build_object('strategyId',p_strategy_id,'runningVersion',p_version);
end;
$$;

revoke all on function public.black_core_start_strategy_version(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.black_core_start_strategy_version(uuid,uuid,integer) to service_role;

create or replace function public.black_core_control_strategy_target(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_binding_id uuid,
  p_expected_row_version integer,
  p_action text,
  p_validation_snapshot jsonb,
  p_disconnect_policy text,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  binding public.strategy_target_bindings;
  prior_request public.strategy_target_mutation_requests;
  next_status text;
  event_name text;
  now_at timestamptz := now();
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_target_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.binding_id<>p_binding_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',p_binding_id,'rowVersion',prior_request.row_version,'status',prior_request.target_status,'idempotent',true);
  end if;
  select * into binding from public.strategy_target_bindings where id=p_binding_id and strategy_id=p_strategy_id
    and owner_user_id=p_owner_user_id for update;
  if binding.id is null then raise exception 'strategy target ownership mismatch' using errcode='42501'; end if;
  if binding.row_version<>p_expected_row_version then raise exception 'strategy target version conflict' using errcode='40001'; end if;
  if p_action='ARM' then
    if binding.target_type<>'BROKER_ACCOUNT' or binding.status<>'READY' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if coalesce((p_validation_snapshot->>'eligible')::boolean,false) is not true then raise exception 'strategy target validation failed' using errcode='55000'; end if;
    if binding.strategy_allocation_value<=0 or binding.trade_amount_value<=0 or binding.maximum_position_percent<=0
      or binding.maximum_exposure_percent<=0 or binding.maximum_daily_loss<=0 or binding.maximum_drawdown<=0 then
      raise exception 'strategy target risk policy is not armed' using errcode='55000';
    end if;
    next_status := 'LIVE';
    event_name := 'STRATEGY_DEMO_TARGET_ARMED';
    update public.strategy_target_bindings set status=next_status,armed_at=now_at,paused_at=null,
      validation_snapshot=p_validation_snapshot,row_version=row_version+1 where id=binding.id;
    update public.strategy_automation_strategies set status='LIVE_ACTIVE',updated_at=now_at
      where id=p_strategy_id and owner_user_id=p_owner_user_id;
  elsif p_action='PAUSE' then
    if binding.status not in ('READY','LIVE','DEGRADED','RISK_SUSPENDED') then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    next_status := 'PAUSED';
    event_name := 'STRATEGY_TARGET_PAUSED';
    update public.strategy_target_bindings set status=next_status,paused_at=now_at,row_version=row_version+1 where id=binding.id;
  elsif p_action='RESUME' then
    if binding.status<>'PAUSED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if coalesce((p_validation_snapshot->>'eligible')::boolean,false) is not true then raise exception 'strategy target validation failed' using errcode='55000'; end if;
    next_status := case when binding.armed_at is null then 'READY' else 'LIVE' end;
    event_name := 'STRATEGY_TARGET_RESUMED';
    update public.strategy_target_bindings set status=next_status,paused_at=null,validation_snapshot=p_validation_snapshot,row_version=row_version+1 where id=binding.id;
  elsif p_action='DISCONNECT' then
    if binding.status='DISCONNECTED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if p_disconnect_policy not in ('DETACH_MANUAL','CLOSE_STRATEGY_POSITIONS','KEEP_PROTECTED','DISCONNECT_WHEN_FLAT') then raise exception 'invalid disconnect policy' using errcode='22023'; end if;
    next_status := 'DISCONNECTED';
    event_name := 'STRATEGY_TARGET_DISCONNECTED';
    update public.strategy_target_bindings set status=next_status,disconnected_at=now_at,disconnect_policy=p_disconnect_policy,row_version=row_version+1 where id=binding.id;
  else raise exception 'invalid strategy target action' using errcode='22023';
  end if;
  insert into public.strategy_target_mutation_requests(owner_user_id,strategy_id,binding_id,idempotency_key,request_hash,row_version,target_status)
  values(p_owner_user_id,p_strategy_id,p_binding_id,p_idempotency_key,p_request_hash,p_expected_row_version+1,next_status);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,severity,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,p_binding_id,event_name,case when p_action='DISCONNECT' then 'WARNING' else 'INFO' end,
    case when p_action='ARM' then 'A Bybit Demo Trading target was armed for simulated-funds strategy execution.'
      when p_action='DISCONNECT' then 'A target binding was revoked and its slot was returned to empty.'
      else 'A strategy target lifecycle action was applied atomically.' end,
    jsonb_build_object('action',p_action,'slotIndex',binding.slot_index,'status',next_status,'disconnectPolicy',p_disconnect_policy,'historicalRecordsPreserved',true));
  return jsonb_build_object('bindingId',p_binding_id,'rowVersion',p_expected_row_version+1,'status',next_status,'idempotent',false);
end;
$$;

revoke all on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) to service_role;

comment on index public.idx_strategy_target_one_live_per_account is 'One armed strategy per demo account until venue position attribution supports safe multi-strategy netting.';
comment on column public.execution_commands.strategy_signal_key is 'Closed-candle strategy signal identity used for exactly-once demo order command creation.';

commit;
