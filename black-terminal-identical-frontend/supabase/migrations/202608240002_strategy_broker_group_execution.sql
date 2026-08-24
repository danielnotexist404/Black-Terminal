-- Certified Strategy Lab broker execution and Investment Group fanout.
-- Demo and Mainnet credentials remain isolated at the command queue and worker
-- boundaries. Withdrawal and asset-transfer authority remain structurally
-- forbidden. This migration performs no broker-side mutation.
begin;

alter table public.execution_orders
  drop constraint if exists execution_orders_origin_check;
alter table public.execution_orders
  add constraint execution_orders_origin_check check (
    origin in ('MANUAL_BLACK_TERMINAL','INVESTMENT_GROUP','STRATEGY_AUTOMATION_DEMO','STRATEGY_AUTOMATION_LIVE','EXTERNAL_VENUE','PROTECTIVE')
  );

alter table public.group_trade_intents
  add column if not exists strategy_automation_id uuid references public.strategy_automation_strategies(id) on delete set null,
  add column if not exists strategy_target_binding_id uuid references public.strategy_target_bindings(id) on delete set null,
  add column if not exists strategy_action text,
  add column if not exists strategy_direction text,
  add column if not exists strategy_execution_policy jsonb not null default '{}'::jsonb;

alter table public.group_trade_intents
  drop constraint if exists group_trade_intents_strategy_action_check,
  add constraint group_trade_intents_strategy_action_check check (strategy_action is null or strategy_action='SYNC_DIRECTION'),
  drop constraint if exists group_trade_intents_strategy_direction_check,
  add constraint group_trade_intents_strategy_direction_check check (strategy_direction is null or strategy_direction in ('long','short')),
  drop constraint if exists group_trade_intents_strategy_shape_check,
  add constraint group_trade_intents_strategy_shape_check check (
    (strategy_automation_id is null and strategy_target_binding_id is null and strategy_action is null and strategy_direction is null)
    or
    (strategy_automation_id is not null and strategy_target_binding_id is not null and strategy_action='SYNC_DIRECTION' and strategy_direction in ('long','short'))
  );

create unique index if not exists idx_group_trade_intents_strategy_signal
  on public.group_trade_intents(strategy_target_binding_id,client_intent_id)
  where strategy_target_binding_id is not null;

alter table public.execution_commands
  add column if not exists execution_environment text;
alter table public.execution_commands
  drop constraint if exists execution_commands_execution_environment_check,
  add constraint execution_commands_execution_environment_check check (execution_environment is null or execution_environment in ('DEMO','MAINNET_LIVE'));
alter table public.execution_commands
  drop constraint if exists execution_commands_strategy_shape_check;
alter table public.execution_commands
  add constraint execution_commands_strategy_shape_check check (
    (strategy_target_binding_id is null and strategy_automation_id is null and strategy_signal_key is null)
    or
    (command_type in ('PLACE_ORDER','EXPAND_GROUP_INTENT') and strategy_target_binding_id is not null and strategy_automation_id is not null and length(strategy_signal_key) between 16 and 512)
  );

create or replace function public.black_cloud_set_command_environment()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.connection_id is not null then
    select c.execution_environment into new.execution_environment
    from public.connectivity_connections c where c.id=new.connection_id;
    if new.execution_environment not in ('DEMO','MAINNET_LIVE') then
      raise exception 'execution command connection environment is invalid' using errcode='22023';
    end if;
  else
    new.execution_environment := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_black_cloud_command_environment on public.execution_commands;
create trigger trg_black_cloud_command_environment
before insert or update of connection_id on public.execution_commands
for each row execute function public.black_cloud_set_command_environment();

update public.execution_commands command
set execution_environment=connection.execution_environment
from public.connectivity_connections connection
where command.connection_id=connection.id
  and command.execution_environment is distinct from connection.execution_environment;

drop function if exists public.black_cloud_claim_execution_commands(text,integer,integer);

create or replace function public.black_cloud_claim_execution_commands(
  p_worker_id text,
  p_limit integer default 10,
  p_lock_seconds integer default 45,
  p_execution_environment text default null,
  p_claim_global boolean default false
)
returns setof public.execution_commands
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  if p_execution_environment is null or p_execution_environment not in ('DEMO','MAINNET_LIVE') then raise exception 'worker execution environment is required' using errcode='22023'; end if;
  return query
  with candidates as (
    select c.id
    from public.execution_commands c
    where c.status in ('QUEUED','RETRY','SUBMISSION_UNKNOWN','RECONCILING')
      and c.available_at <= now()
      and (c.locked_until is null or c.locked_until <= now())
      and c.attempt_count < c.max_attempts
      and (c.execution_environment=p_execution_environment or (p_claim_global and c.connection_id is null))
    order by c.priority asc,c.available_at asc,c.created_at asc
    for update skip locked
    limit greatest(1,least(p_limit,100))
  )
  update public.execution_commands c set
    status='PROCESSING',locked_by=p_worker_id,
    locked_until=now()+make_interval(secs=>greatest(10,least(p_lock_seconds,300))),
    attempt_count=c.attempt_count+1,updated_at=now()
  from candidates x where c.id=x.id returning c.*;
end;
$$;

revoke all on function public.black_cloud_claim_execution_commands(text,integer,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.black_cloud_claim_execution_commands(text,integer,integer,text,boolean) to service_role;

create or replace function public.black_cloud_activate_automation_mandate_v2(
  p_user_id uuid,p_connection_id uuid,p_policy jsonb,
  p_canonical_hash text,p_service_signature text,p_consent_evidence jsonb,
  p_risk_policy jsonb,p_risk_canonical_hash text,p_risk_service_signature text
)
returns public.broker_automation_mandates
language plpgsql security definer set search_path=public as $$
declare
  next_version integer;
  next_risk_version integer;
  expected_version integer;
  expected_risk_version integer;
  environment text;
  expected_action text;
  result public.broker_automation_mandates;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'execution service identity required' using errcode='42501'; end if;
  environment := p_policy->>'executionEnvironment';
  if environment not in ('DEMO','MAINNET_LIVE') then raise exception 'unsupported execution environment' using errcode='22023'; end if;
  expected_action := case when environment='DEMO' then 'ACTIVATE_BYBIT_DEMO_STRATEGY_EXECUTION' else 'ACTIVATE_BYBIT_MAINNET_STRATEGY_EXECUTION' end;
  if not exists(
    select 1 from public.connectivity_connections
    where id=p_connection_id and user_id=p_user_id and revoked_at is null and disabled_at is null
      and provider='bybit' and execution_environment=environment and endpoint_profile='GLOBAL'
  ) then raise exception 'connection ownership or locked environment mismatch' using errcode='42501'; end if;
  if not exists(
    select 1 from public.broker_connection_capabilities
    where connection_id=p_connection_id and can_place_market_orders is true
      and can_execute_while_offline is true and can_withdraw is false and can_transfer is false
  ) then raise exception 'safe execution capabilities are incomplete' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowWithdrawals')::boolean,false) then raise exception 'withdrawal automation is forbidden' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowTransfers')::boolean,false) then raise exception 'wallet transfer automation is forbidden' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowStrategyExecution')::boolean,false) is not true then raise exception 'strategy execution authority is required' using errcode='22023'; end if;
  if coalesce((p_policy->>'allowCopyTrading')::boolean,false) then raise exception 'unscoped copy trading authority is forbidden' using errcode='42501'; end if;
  if coalesce((p_policy->>'allowInvestmentGroupExecution')::boolean,false) and not exists(
    select 1 from public.broker_connection_capabilities where connection_id=p_connection_id and can_receive_group_orders is true
  ) then raise exception 'investment group capability is incomplete' using errcode='42501'; end if;
  if coalesce(p_consent_evidence->>'executionEnvironment','') <> environment then raise exception 'consent environment mismatch' using errcode='42501'; end if;
  if coalesce(p_consent_evidence->>'action','') <> expected_action then raise exception 'strategy activation evidence missing' using errcode='42501'; end if;
  if coalesce((p_consent_evidence->>'persistentAfterLogout')::boolean,false) is not true then raise exception 'persistent execution evidence missing' using errcode='42501'; end if;
  if length(coalesce(p_canonical_hash,''))<>64 or length(coalesce(p_risk_canonical_hash,''))<>64 then raise exception 'canonical policy hash invalid' using errcode='22023'; end if;
  if length(coalesce(p_service_signature,''))<32 or length(coalesce(p_risk_service_signature,''))<32 then raise exception 'service signature invalid' using errcode='22023'; end if;
  if nullif(p_policy->>'expiresAt','') is not null and (p_policy->>'expiresAt')::timestamptz<=now() then raise exception 'automation mandate has expired' using errcode='22023'; end if;
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
    true,true,true,true,true,false,coalesce((p_policy->>'allowInvestmentGroupExecution')::boolean,false),false,
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
  insert into public.broker_risk_policy_versions(user_id,connection_id,mandate_id,execution_environment,policy_version,policy_snapshot,canonical_hash,service_signature,confirmation_evidence)
  values(p_user_id,p_connection_id,result.id,environment,next_risk_version,p_risk_policy,p_risk_canonical_hash,p_risk_service_signature,p_consent_evidence);
  insert into public.connection_audit_events(user_id,connection_id,mandate_id,event_type,message,safe_metadata)
  values(p_user_id,p_connection_id,result.id,'STRATEGY_AUTOMATION_AUTHORIZED','The user activated persistent Strategy Lab execution on a trade-only Bybit account.',
    jsonb_build_object('version',next_version,'riskPolicyVersion',next_risk_version,'executionEnvironment',environment,'simulatedFunds',environment='DEMO','investmentGroupExecution',result.allow_investment_group_execution,'withdrawalPermission',false,'transferPermission',false,'expiresAt',result.expires_at));
  return result;
end;
$$;

revoke all on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.black_cloud_activate_automation_mandate_v2(uuid,uuid,jsonb,text,text,jsonb,jsonb,text,text) to service_role;

create or replace function public.black_core_control_strategy_target(
  p_owner_user_id uuid,p_strategy_id uuid,p_binding_id uuid,p_expected_row_version integer,
  p_action text,p_validation_snapshot jsonb,p_disconnect_policy text,p_request_hash text,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  binding public.strategy_target_bindings;
  prior_request public.strategy_target_mutation_requests;
  next_status text;
  event_name text;
  now_at timestamptz:=now();
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_target_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.binding_id<>p_binding_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',p_binding_id,'rowVersion',prior_request.row_version,'status',prior_request.target_status,'idempotent',true);
  end if;
  select * into binding from public.strategy_target_bindings where id=p_binding_id and strategy_id=p_strategy_id and owner_user_id=p_owner_user_id for update;
  if binding.id is null then raise exception 'strategy target ownership mismatch' using errcode='42501'; end if;
  if binding.row_version<>p_expected_row_version then raise exception 'strategy target version conflict' using errcode='40001'; end if;
  if p_action='ARM' then
    if binding.target_type not in ('BROKER_ACCOUNT','INVESTMENT_GROUP') or binding.status<>'READY' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if coalesce((p_validation_snapshot->>'eligible')::boolean,false) is not true then raise exception 'strategy target validation failed' using errcode='55000'; end if;
    if binding.strategy_allocation_value<=0 or binding.trade_amount_value<=0 or binding.maximum_position_percent<=0 or binding.maximum_exposure_percent<=0 or binding.maximum_daily_loss<=0 or binding.maximum_drawdown<=0 then raise exception 'strategy target risk policy is not armed' using errcode='55000'; end if;
    next_status:='LIVE';
    event_name:=case when binding.target_type='INVESTMENT_GROUP' then 'STRATEGY_GROUP_TARGET_ARMED' else 'STRATEGY_BROKER_TARGET_ARMED' end;
    update public.strategy_target_bindings set status=next_status,armed_at=now_at,paused_at=null,validation_snapshot=p_validation_snapshot,row_version=row_version+1 where id=binding.id;
    update public.strategy_automation_strategies set status='LIVE_ACTIVE',updated_at=now_at where id=p_strategy_id and owner_user_id=p_owner_user_id;
  elsif p_action='PAUSE' then
    if binding.status not in ('READY','LIVE','DEGRADED','RISK_SUSPENDED') then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    next_status:='PAUSED';event_name:='STRATEGY_TARGET_PAUSED';
    update public.strategy_target_bindings set status=next_status,paused_at=now_at,row_version=row_version+1 where id=binding.id;
  elsif p_action='RESUME' then
    if binding.status<>'PAUSED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if coalesce((p_validation_snapshot->>'eligible')::boolean,false) is not true then raise exception 'strategy target validation failed' using errcode='55000'; end if;
    next_status:=case when binding.armed_at is null then 'READY' else 'LIVE' end;event_name:='STRATEGY_TARGET_RESUMED';
    update public.strategy_target_bindings set status=next_status,paused_at=null,validation_snapshot=p_validation_snapshot,row_version=row_version+1 where id=binding.id;
  elsif p_action='DISCONNECT' then
    if binding.status='DISCONNECTED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if p_disconnect_policy not in ('DETACH_MANUAL','CLOSE_STRATEGY_POSITIONS','KEEP_PROTECTED','DISCONNECT_WHEN_FLAT') then raise exception 'invalid disconnect policy' using errcode='22023'; end if;
    next_status:='DISCONNECTED';event_name:='STRATEGY_TARGET_DISCONNECTED';
    update public.strategy_target_bindings set status=next_status,disconnected_at=now_at,disconnect_policy=p_disconnect_policy,row_version=row_version+1 where id=binding.id;
  else raise exception 'invalid strategy target action' using errcode='22023'; end if;
  insert into public.strategy_target_mutation_requests(owner_user_id,strategy_id,binding_id,idempotency_key,request_hash,row_version,target_status)
  values(p_owner_user_id,p_strategy_id,p_binding_id,p_idempotency_key,p_request_hash,p_expected_row_version+1,next_status);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,severity,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,p_binding_id,event_name,case when p_action='DISCONNECT' then 'WARNING' else 'INFO' end,
    case when p_action='ARM' then 'A broker or Investment Group target was armed for server-authoritative Strategy Lab execution.' when p_action='DISCONNECT' then 'A target binding was revoked and its slot was returned to empty.' else 'A strategy target lifecycle action was applied atomically.' end,
    jsonb_build_object('action',p_action,'targetType',binding.target_type,'slotIndex',binding.slot_index,'status',next_status,'disconnectPolicy',p_disconnect_policy,'historicalRecordsPreserved',true));
  return jsonb_build_object('bindingId',p_binding_id,'rowVersion',p_expected_row_version+1,'status',next_status,'idempotent',false);
end;
$$;

revoke all on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) to service_role;

comment on function public.black_cloud_claim_execution_commands(text,integer,integer,text,boolean) is 'Claims only commands for one isolated Bybit execution environment; only the Mainnet control worker may claim connectionless group-expansion commands.';
comment on column public.execution_commands.execution_environment is 'Immutable worker-routing boundary derived from the linked broker connection.';

commit;
