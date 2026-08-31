begin;

-- A policy save is an explicit owner action, not a lifecycle command. Live
-- targets therefore remain LIVE when the replacement policy passes a fresh
-- execution preflight. Failed validation aborts the transaction, preserving
-- both the previous policy and the target's armed state.
create or replace function public.black_core_update_strategy_target_policy_v2(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_binding_id uuid,
  p_expected_row_version integer,
  p_policy jsonb,
  p_canonical_hash text,
  p_risk_increased boolean,
  p_validation_snapshot jsonb,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  binding public.strategy_target_bindings;
  prior_request public.strategy_target_mutation_requests;
  next_policy_version integer;
  now_at timestamptz := now();
  validation_checked_at timestamptz;
  preflight_checked_at timestamptz;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'strategy service identity required' using errcode='42501';
  end if;

  select * into prior_request
  from public.strategy_target_mutation_requests
  where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id
      or prior_request.binding_id<>p_binding_id
      or prior_request.request_hash<>p_request_hash then
      raise exception 'idempotency key payload mismatch' using errcode='22023';
    end if;
    return jsonb_build_object(
      'bindingId',p_binding_id,
      'rowVersion',prior_request.row_version,
      'status',prior_request.target_status,
      'idempotent',true
    );
  end if;

  select * into binding
  from public.strategy_target_bindings
  where id=p_binding_id
    and strategy_id=p_strategy_id
    and owner_user_id=p_owner_user_id
    and status<>'DISCONNECTED'
  for update;
  if binding.id is null then
    raise exception 'strategy target ownership mismatch' using errcode='42501';
  end if;
  if binding.row_version<>p_expected_row_version then
    raise exception 'strategy target version conflict' using errcode='40001';
  end if;
  if jsonb_typeof(p_policy) is distinct from 'object' or length(p_canonical_hash)<>64 then
    raise exception 'invalid strategy target policy payload' using errcode='22023';
  end if;

  if binding.status='LIVE' then
    if jsonb_typeof(p_validation_snapshot) is distinct from 'object'
      or p_validation_snapshot->>'eligible' is distinct from 'true'
      or p_validation_snapshot->>'policyCanonicalHash' is distinct from p_canonical_hash then
      raise exception 'live strategy target policy validation failed' using errcode='55000';
    end if;
    begin
      validation_checked_at := nullif(p_validation_snapshot->>'validatedAt','')::timestamptz;
    exception when others then
      raise exception 'live strategy target policy validation timestamp is invalid' using errcode='55000';
    end;
    if validation_checked_at is null
      or validation_checked_at < now_at - interval '5 minutes'
      or validation_checked_at > now_at + interval '1 minute' then
      raise exception 'live strategy target policy validation is stale' using errcode='55000';
    end if;

    if binding.market_type='FUTURES' then
      if p_validation_snapshot->>'executionPreflightRequired' is distinct from 'true'
        or jsonb_typeof(p_validation_snapshot->'executionPreflight') is distinct from 'object'
        or p_validation_snapshot->'executionPreflight'->>'ok' is distinct from 'true'
        or p_validation_snapshot->'executionPreflight'->>'strategyVersion' is distinct from binding.strategy_version::text then
        raise exception 'live futures strategy execution preflight failed' using errcode='55000';
      end if;
      begin
        preflight_checked_at := nullif(p_validation_snapshot->'executionPreflight'->>'checkedAt','')::timestamptz;
      exception when others then
        raise exception 'live futures strategy execution preflight timestamp is invalid' using errcode='55000';
      end;
      if preflight_checked_at is null
        or preflight_checked_at < now_at - interval '5 minutes'
        or preflight_checked_at > now_at + interval '1 minute' then
        raise exception 'live futures strategy execution preflight is stale' using errcode='55000';
      end if;
    end if;
  end if;

  next_policy_version := binding.capital_policy_version+1;
  update public.strategy_target_bindings set
    strategy_allocation_mode=p_policy->>'strategyAllocationMode',
    strategy_allocation_value=(p_policy->>'strategyAllocationValue')::numeric,
    trade_amount_mode=p_policy->>'tradeAmountMode',
    trade_amount_value=(p_policy->>'tradeAmountValue')::numeric,
    requested_leverage=nullif(p_policy->>'requestedLeverage','')::numeric,
    requested_long_leverage=coalesce(nullif(p_policy->>'requestedLongLeverage','')::numeric,nullif(p_policy->>'requestedLeverage','')::numeric),
    requested_short_leverage=coalesce(nullif(p_policy->>'requestedShortLeverage','')::numeric,nullif(p_policy->>'requestedLeverage','')::numeric),
    maximum_leverage=nullif(p_policy->>'maximumLeverage','')::numeric,
    maximum_position_percent=(p_policy->>'maximumPositionPercent')::numeric,
    maximum_exposure_percent=(p_policy->>'maximumExposurePercent')::numeric,
    maximum_daily_loss=(p_policy->>'maximumDailyLoss')::numeric,
    maximum_drawdown=(p_policy->>'maximumDrawdown')::numeric,
    maximum_positions=(p_policy->>'maximumPositions')::integer,
    slippage_bps=(p_policy->>'slippageBps')::numeric,
    margin_mode=nullif(p_policy->>'marginMode',''),
    quote_asset_reserve_percent=nullif(p_policy->>'quoteAssetReservePercent','')::numeric,
    maximum_base_asset_exposure_percent=nullif(p_policy->>'maximumBaseAssetExposurePercent','')::numeric,
    capital_policy_version=next_policy_version,
    row_version=row_version+1,
    updated_at=now_at,
    validation_snapshot=case
      when binding.status='LIVE' then
        p_validation_snapshot || jsonb_build_object(
          'revalidationRequired',false,
          'validatedAt',now_at,
          'policyCanonicalHash',p_canonical_hash
        )
      when p_risk_increased then
        validation_snapshot || jsonb_build_object(
          'revalidationRequired',true,
          'validatedAt',null,
          'policyCanonicalHash',p_canonical_hash
        )
      else validation_snapshot
    end
  where id=p_binding_id;

  insert into public.strategy_target_policy_versions(
    binding_id,strategy_id,owner_user_id,version,policy_snapshot,canonical_hash,change_kind
  ) values (
    p_binding_id,p_strategy_id,p_owner_user_id,next_policy_version,p_policy,p_canonical_hash,
    case when p_risk_increased then 'RISK_INCREASED' else 'RISK_REDUCED' end
  );
  insert into public.strategy_target_mutation_requests(
    owner_user_id,strategy_id,binding_id,idempotency_key,request_hash,row_version,target_status
  ) values (
    p_owner_user_id,p_strategy_id,p_binding_id,p_idempotency_key,p_request_hash,
    p_expected_row_version+1,binding.status
  );
  insert into public.strategy_automation_audit_events(
    owner_user_id,strategy_id,binding_id,event_type,severity,message,safe_metadata
  ) values (
    p_owner_user_id,p_strategy_id,p_binding_id,'STRATEGY_TARGET_CAPITAL_POLICY_CHANGED',
    case when p_risk_increased then 'WARNING' else 'INFO' end,
    case when binding.status='LIVE'
      then 'A target policy was atomically validated and saved without changing its live execution state.'
      else 'A target capital and risk policy was atomically versioned without changing its lifecycle state.'
    end,
    jsonb_build_object(
      'version',next_policy_version,
      'riskIncrease',p_risk_increased,
      'requestedLongLeverage',p_policy->'requestedLongLeverage',
      'requestedShortLeverage',p_policy->'requestedShortLeverage',
      'statusPreserved',binding.status,
      'targetStayedLive',binding.status='LIVE',
      'liveRevalidationPassed',binding.status='LIVE'
    )
  );
  return jsonb_build_object(
    'bindingId',p_binding_id,
    'rowVersion',p_expected_row_version+1,
    'status',binding.status,
    'idempotent',false
  );
end;
$$;

revoke all on function public.black_core_update_strategy_target_policy_v2(uuid,uuid,uuid,integer,jsonb,text,boolean,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.black_core_update_strategy_target_policy_v2(uuid,uuid,uuid,integer,jsonb,text,boolean,jsonb,text,text) to service_role;

comment on function public.black_core_update_strategy_target_policy_v2(uuid,uuid,uuid,integer,jsonb,text,boolean,jsonb,text,text) is
  'Atomically versions a target policy while preserving lifecycle state; a LIVE target requires a fresh policy-bound execution preflight and remains LIVE after a valid save.';

-- Keep rolling deploys and emergency API rollbacks safe. Older API releases do
-- not supply a policy-bound validation snapshot, so their live updates fail
-- atomically through V2 instead of invoking the historical auto-disarm logic.
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
begin
  return public.black_core_update_strategy_target_policy_v2(
    p_owner_user_id,
    p_strategy_id,
    p_binding_id,
    p_expected_row_version,
    p_policy,
    p_canonical_hash,
    p_risk_increased,
    '{}'::jsonb,
    p_request_hash,
    p_idempotency_key
  );
end;
$$;

revoke all on function public.black_core_update_strategy_target_policy(uuid,uuid,uuid,integer,jsonb,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.black_core_update_strategy_target_policy(uuid,uuid,uuid,integer,jsonb,text,boolean,text,text) to service_role;

comment on function public.black_core_update_strategy_target_policy(uuid,uuid,uuid,integer,jsonb,text,boolean,text,text) is
  'Compatibility boundary for older API releases. Non-live saves preserve lifecycle state; live saves fail closed until the API supplies V2 policy-bound validation.';

commit;
