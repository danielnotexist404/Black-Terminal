begin;

-- Preserve directional leverage as part of each execution destination's
-- versioned capital policy. The generic requested_leverage remains the
-- conservative compatibility value used by older workers and reports.
alter table public.strategy_target_bindings
  add column if not exists requested_long_leverage numeric,
  add column if not exists requested_short_leverage numeric;

update public.strategy_target_bindings
set requested_long_leverage=coalesce(requested_long_leverage,requested_leverage),
    requested_short_leverage=coalesce(requested_short_leverage,requested_leverage)
where market_type='FUTURES';

do $$
begin
  if not exists(select 1 from pg_constraint where conname='strategy_target_requested_long_leverage_check') then
    alter table public.strategy_target_bindings add constraint strategy_target_requested_long_leverage_check
      check ((market_type='SPOT' and requested_long_leverage is null) or (market_type='FUTURES' and requested_long_leverage>=1));
  end if;
  if not exists(select 1 from pg_constraint where conname='strategy_target_requested_short_leverage_check') then
    alter table public.strategy_target_bindings add constraint strategy_target_requested_short_leverage_check
      check ((market_type='SPOT' and requested_short_leverage is null) or (market_type='FUTURES' and requested_short_leverage>=1));
  end if;
end;
$$;

create or replace function public.black_core_add_strategy_target(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_strategy_version integer,
  p_slot_index integer,
  p_target_type text,
  p_target_id uuid,
  p_connection_id uuid,
  p_account_id uuid,
  p_group_id uuid,
  p_market_type text,
  p_policy jsonb,
  p_validation jsonb,
  p_canonical_hash text,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  strategy_row public.strategy_automation_strategies;
  existing_id uuid;
  existing_hash text;
  created_binding public.strategy_target_bindings;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if p_slot_index not between 1 and 9 then raise exception 'invalid target slot' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-target:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  if strategy_row.current_version <> p_strategy_version then raise exception 'strategy version conflict' using errcode='40001'; end if;
  select id,request_hash into existing_id,existing_hash from public.strategy_target_bindings where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if existing_id is not null then
    if existing_hash <> p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',existing_id,'idempotent',true);
  end if;
  if (select count(*) from public.strategy_target_bindings where strategy_id=p_strategy_id and strategy_version=p_strategy_version and status<>'DISCONNECTED') >= 9 then
    raise exception 'live target capacity reached' using errcode='23514';
  end if;
  insert into public.strategy_target_bindings(
    strategy_id,strategy_version,owner_user_id,slot_index,target_type,target_id,connection_id,account_id,group_id,market_type,status,
    strategy_allocation_mode,strategy_allocation_value,trade_amount_mode,trade_amount_value,requested_leverage,requested_long_leverage,requested_short_leverage,maximum_leverage,
    maximum_position_percent,maximum_exposure_percent,maximum_daily_loss,maximum_drawdown,maximum_positions,slippage_bps,margin_mode,
    quote_asset_reserve_percent,maximum_base_asset_exposure_percent,
    validation_snapshot,idempotency_key,request_hash
  ) values (
    p_strategy_id,p_strategy_version,p_owner_user_id,p_slot_index,p_target_type,p_target_id,p_connection_id,p_account_id,p_group_id,p_market_type,'READY',
    p_policy->>'strategyAllocationMode',(p_policy->>'strategyAllocationValue')::numeric,p_policy->>'tradeAmountMode',(p_policy->>'tradeAmountValue')::numeric,
    nullif(p_policy->>'requestedLeverage','')::numeric,
    coalesce(nullif(p_policy->>'requestedLongLeverage','')::numeric,nullif(p_policy->>'requestedLeverage','')::numeric),
    coalesce(nullif(p_policy->>'requestedShortLeverage','')::numeric,nullif(p_policy->>'requestedLeverage','')::numeric),
    nullif(p_policy->>'maximumLeverage','')::numeric,
    (p_policy->>'maximumPositionPercent')::numeric,(p_policy->>'maximumExposurePercent')::numeric,(p_policy->>'maximumDailyLoss')::numeric,
    (p_policy->>'maximumDrawdown')::numeric,(p_policy->>'maximumPositions')::integer,(p_policy->>'slippageBps')::numeric,nullif(p_policy->>'marginMode',''),
    nullif(p_policy->>'quoteAssetReservePercent','')::numeric,nullif(p_policy->>'maximumBaseAssetExposurePercent','')::numeric,
    p_validation,p_idempotency_key,p_request_hash
  ) returning * into created_binding;
  insert into public.strategy_target_policy_versions(binding_id,strategy_id,owner_user_id,version,policy_snapshot,canonical_hash,change_kind)
  values(created_binding.id,p_strategy_id,p_owner_user_id,1,p_policy,p_canonical_hash,'CREATED');
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,created_binding.id,'STRATEGY_TARGET_ADDED','A validated strategy target occupied one of nine persistent slots.',jsonb_build_object('slotIndex',p_slot_index,'targetType',p_target_type,'marketType',p_market_type,'allocation',0,'targetCapacity',9));
  return jsonb_build_object('bindingId',created_binding.id,'idempotent',false);
end;
$$;

create or replace function public.black_core_update_strategy_target_policy(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_binding_id uuid,
  p_expected_row_version integer,
  p_policy jsonb,
  p_canonical_hash text,
  p_risk_increased boolean,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  binding public.strategy_target_bindings;
  prior_request public.strategy_target_mutation_requests;
  next_policy_version integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_target_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.binding_id<>p_binding_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',p_binding_id,'rowVersion',prior_request.row_version,'status',prior_request.target_status,'idempotent',true);
  end if;
  select * into binding from public.strategy_target_bindings where id=p_binding_id and strategy_id=p_strategy_id
    and owner_user_id=p_owner_user_id and status<>'DISCONNECTED' for update;
  if binding.id is null then raise exception 'strategy target ownership mismatch' using errcode='42501'; end if;
  if binding.row_version<>p_expected_row_version then raise exception 'strategy target version conflict' using errcode='40001'; end if;
  next_policy_version := binding.capital_policy_version+1;
  update public.strategy_target_bindings set
    strategy_allocation_mode=p_policy->>'strategyAllocationMode',strategy_allocation_value=(p_policy->>'strategyAllocationValue')::numeric,
    trade_amount_mode=p_policy->>'tradeAmountMode',trade_amount_value=(p_policy->>'tradeAmountValue')::numeric,
    requested_leverage=nullif(p_policy->>'requestedLeverage','')::numeric,
    requested_long_leverage=coalesce(nullif(p_policy->>'requestedLongLeverage','')::numeric,nullif(p_policy->>'requestedLeverage','')::numeric),
    requested_short_leverage=coalesce(nullif(p_policy->>'requestedShortLeverage','')::numeric,nullif(p_policy->>'requestedLeverage','')::numeric),
    maximum_leverage=nullif(p_policy->>'maximumLeverage','')::numeric,
    maximum_position_percent=(p_policy->>'maximumPositionPercent')::numeric,maximum_exposure_percent=(p_policy->>'maximumExposurePercent')::numeric,
    maximum_daily_loss=(p_policy->>'maximumDailyLoss')::numeric,maximum_drawdown=(p_policy->>'maximumDrawdown')::numeric,
    maximum_positions=(p_policy->>'maximumPositions')::integer,slippage_bps=(p_policy->>'slippageBps')::numeric,
    margin_mode=nullif(p_policy->>'marginMode',''),quote_asset_reserve_percent=nullif(p_policy->>'quoteAssetReservePercent','')::numeric,
    maximum_base_asset_exposure_percent=nullif(p_policy->>'maximumBaseAssetExposurePercent','')::numeric,
    capital_policy_version=next_policy_version,row_version=row_version+1,
    validation_snapshot=case when p_risk_increased then validation_snapshot||jsonb_build_object('revalidationRequired',true,'validatedAt',null) else validation_snapshot end,
    status=case when p_risk_increased then 'READY' else status end,
    armed_at=case when p_risk_increased then null else armed_at end
  where id=p_binding_id;
  insert into public.strategy_target_policy_versions(binding_id,strategy_id,owner_user_id,version,policy_snapshot,canonical_hash,change_kind)
  values(p_binding_id,p_strategy_id,p_owner_user_id,next_policy_version,p_policy,p_canonical_hash,case when p_risk_increased then 'RISK_INCREASED' else 'RISK_REDUCED' end);
  insert into public.strategy_target_mutation_requests(owner_user_id,strategy_id,binding_id,idempotency_key,request_hash,row_version,target_status)
  values(p_owner_user_id,p_strategy_id,p_binding_id,p_idempotency_key,p_request_hash,p_expected_row_version+1,case when p_risk_increased then 'READY' else binding.status end);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,p_binding_id,'STRATEGY_TARGET_CAPITAL_POLICY_CHANGED','A target capital and risk policy was atomically versioned.',
    jsonb_build_object('version',next_policy_version,'riskIncrease',p_risk_increased,'requestedLongLeverage',p_policy->'requestedLongLeverage','requestedShortLeverage',p_policy->'requestedShortLeverage'));
  return jsonb_build_object('bindingId',p_binding_id,'rowVersion',p_expected_row_version+1,'idempotent',false);
end;
$$;

commit;
