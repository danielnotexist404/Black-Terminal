begin;

-- Strategy Lab exposes exactly nine persistent broker/group destinations.
-- Historical disconnected slot-10 rows remain valid for immutable audit history.
do $$
begin
  if exists(select 1 from public.strategy_target_bindings where status <> 'DISCONNECTED' and slot_index = 10) then
    raise exception 'active strategy target occupies retired slot 10; detach or reorder it before applying nine-slot capacity';
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
    strategy_allocation_mode,strategy_allocation_value,trade_amount_mode,trade_amount_value,requested_leverage,maximum_leverage,
    maximum_position_percent,maximum_exposure_percent,maximum_daily_loss,maximum_drawdown,maximum_positions,slippage_bps,margin_mode,
    quote_asset_reserve_percent,maximum_base_asset_exposure_percent,
    validation_snapshot,idempotency_key,request_hash
  ) values (
    p_strategy_id,p_strategy_version,p_owner_user_id,p_slot_index,p_target_type,p_target_id,p_connection_id,p_account_id,p_group_id,p_market_type,'READY',
    p_policy->>'strategyAllocationMode',(p_policy->>'strategyAllocationValue')::numeric,p_policy->>'tradeAmountMode',(p_policy->>'tradeAmountValue')::numeric,
    nullif(p_policy->>'requestedLeverage','')::numeric,nullif(p_policy->>'maximumLeverage','')::numeric,
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

create or replace function public.black_core_reorder_strategy_targets(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_strategy_version integer,
  p_assignments jsonb,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  strategy_row public.strategy_automation_strategies;
  prior_request public.strategy_target_reorder_requests;
  prior_statuses jsonb;
  assignment jsonb;
  assignment_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if jsonb_typeof(p_assignments)<>'array' then raise exception 'invalid target reorder assignments' using errcode='22023'; end if;
  assignment_count := jsonb_array_length(p_assignments);
  if assignment_count not between 1 and 9 then raise exception 'invalid target reorder assignments' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-target:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  if strategy_row.current_version<>p_strategy_version then raise exception 'strategy version conflict' using errcode='40001'; end if;
  select * into prior_request from public.strategy_target_reorder_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('assignments',prior_request.result_snapshot,'idempotent',true);
  end if;
  if (select count(distinct item->>'bindingId') from jsonb_array_elements(p_assignments) item)<>assignment_count
    or (select count(distinct (item->>'slotIndex')::integer) from jsonb_array_elements(p_assignments) item)<>assignment_count
    or exists(select 1 from jsonb_array_elements(p_assignments) item where (item->>'slotIndex')::integer not between 1 and 9) then
    raise exception 'duplicate or invalid target reorder assignment' using errcode='22023';
  end if;
  if (select count(*) from public.strategy_target_bindings b join jsonb_array_elements(p_assignments) item on b.id=(item->>'bindingId')::uuid
      where b.strategy_id=p_strategy_id and b.strategy_version=p_strategy_version and b.owner_user_id=p_owner_user_id and b.status<>'DISCONNECTED'
        and b.row_version=(item->>'expectedVersion')::integer)<>assignment_count then
    raise exception 'strategy target version conflict' using errcode='40001';
  end if;
  if exists(
    select 1 from public.strategy_target_bindings b
    where b.strategy_id=p_strategy_id and b.strategy_version=p_strategy_version and b.status<>'DISCONNECTED'
      and b.slot_index in (select (item->>'slotIndex')::integer from jsonb_array_elements(p_assignments) item)
      and b.id not in (select (item->>'bindingId')::uuid from jsonb_array_elements(p_assignments) item)
  ) then raise exception 'target reorder slot is occupied' using errcode='23505'; end if;
  select jsonb_object_agg(b.id::text,b.status) into prior_statuses from public.strategy_target_bindings b
    where b.id in (select (item->>'bindingId')::uuid from jsonb_array_elements(p_assignments) item);
  update public.strategy_target_bindings set status='DISCONNECTED'
    where id in (select (item->>'bindingId')::uuid from jsonb_array_elements(p_assignments) item);
  for assignment in select * from jsonb_array_elements(p_assignments) loop
    update public.strategy_target_bindings set
      slot_index=(assignment->>'slotIndex')::integer,
      status=prior_statuses->>(assignment->>'bindingId'),
      row_version=row_version+1
    where id=(assignment->>'bindingId')::uuid;
  end loop;
  insert into public.strategy_target_reorder_requests(owner_user_id,strategy_id,strategy_version,idempotency_key,request_hash,result_snapshot)
  values(p_owner_user_id,p_strategy_id,p_strategy_version,p_idempotency_key,p_request_hash,p_assignments);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'STRATEGY_TARGET_SLOTS_REORDERED','Live target display slots were reordered within the nine-destination matrix.',jsonb_build_object('assignmentCount',assignment_count,'targetCapacity',9));
  return jsonb_build_object('assignments',p_assignments,'idempotent',false);
end;
$$;

revoke all on function public.black_core_add_strategy_target(uuid,uuid,integer,integer,text,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function public.black_core_reorder_strategy_targets(uuid,uuid,integer,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.black_core_add_strategy_target(uuid,uuid,integer,integer,text,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text,text) to service_role;
grant execute on function public.black_core_reorder_strategy_targets(uuid,uuid,integer,jsonb,text,text) to service_role;

comment on function public.black_core_add_strategy_target(uuid,uuid,integer,integer,text,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text,text) is 'Adds one validated broker or Investment Group target to the nine-slot Strategy Lab matrix.';

commit;
