-- Atomically persist one complete Strategy Lab execution generation. The
-- service supplies one parent command and zero to seven TP children; PostgreSQL
-- validates their immutable ownership/linkage, inserts any missing idempotent
-- rows and makes the complete generation claimable in the same transaction.
-- No network crash can therefore expose only the entry or silently lose a
-- confirmed signal between the candle checkpoint and command persistence.
begin;

create or replace function public.black_cloud_enqueue_strategy_generation_v1(
  p_strategy_id uuid,
  p_binding_id uuid,
  p_parent_command jsonb,
  p_child_commands jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_commands jsonb;
  v_command jsonb;
  v_children jsonb := coalesce(p_child_commands,'[]'::jsonb);
  v_parent_key text;
  v_parent_type text;
  v_parent_action text;
  v_parent_group_intent_id uuid;
  v_child_count integer;
  v_expected_children integer;
  v_expected integer;
  v_actual integer;
  v_unique integer;
  v_owner_user_id uuid;
  v_target_type text;
  v_binding_connection_id uuid;
  v_binding_group_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'execution service identity required' using errcode='42501';
  end if;
  if p_strategy_id is null or p_binding_id is null
    or jsonb_typeof(p_parent_command) <> 'object'
    or jsonb_typeof(v_children) <> 'array' then
    raise exception 'strategy generation identity and command manifest are required' using errcode='22023';
  end if;

  select b.owner_user_id,b.target_type,b.connection_id,b.group_id
    into v_owner_user_id,v_target_type,v_binding_connection_id,v_binding_group_id
  from public.strategy_target_bindings b
  where b.id=p_binding_id and b.strategy_id=p_strategy_id;
  if v_owner_user_id is null then
    raise exception 'strategy generation binding ownership is invalid' using errcode='42501';
  end if;

  v_child_count := jsonb_array_length(v_children);
  if v_child_count > 7 then
    raise exception 'strategy generation may contain at most seven child commands' using errcode='22023';
  end if;
  v_parent_key := nullif(btrim(p_parent_command->>'idempotencyKey'),'');
  v_parent_type := upper(coalesce(p_parent_command->>'commandType',''));
  v_parent_action := upper(coalesce(p_parent_command->'payload'->>'action',''));
  if v_parent_key is null or v_parent_type not in ('PLACE_ORDER','EXPAND_GROUP_INTENT') then
    raise exception 'strategy generation parent command is invalid' using errcode='22023';
  end if;
  if nullif(btrim(p_parent_command->>'strategySignalKey'),'') is null
    or coalesce((p_parent_command->>'priority')::integer,0) < 0
    or coalesce((p_parent_command->>'maxAttempts')::integer,0) not between 1 and 100 then
    raise exception 'strategy generation parent scheduling contract is invalid' using errcode='22023';
  end if;
  if (v_target_type='BROKER_ACCOUNT' and v_parent_type <> 'PLACE_ORDER')
    or (v_target_type='INVESTMENT_GROUP' and v_parent_type <> 'EXPAND_GROUP_INTENT')
    or v_target_type not in ('BROKER_ACCOUNT','INVESTMENT_GROUP') then
    raise exception 'strategy generation command type does not match its binding authority' using errcode='42501';
  end if;

  v_commands := jsonb_build_array(p_parent_command) || v_children;
  v_expected := 1 + v_child_count;
  select count(distinct item->>'idempotencyKey')
    into v_unique
  from jsonb_array_elements(v_commands) as manifest(item)
  where nullif(btrim(item->>'idempotencyKey'),'') is not null;
  if v_unique <> v_expected then
    raise exception 'strategy generation idempotency keys must be present and unique' using errcode='22023';
  end if;

  if v_parent_type='PLACE_ORDER' then
    if v_parent_action in ('ENTRY','REVERSE') then
      v_expected_children := least(7,coalesce(jsonb_array_length(p_parent_command->'payload'->'takeProfits'),0));
    elsif v_parent_action='CLOSE' then
      v_expected_children := 0;
    else
      raise exception 'direct strategy generation parent action is invalid' using errcode='22023';
    end if;
    if v_child_count <> v_expected_children then
      raise exception 'direct strategy TP manifest count does not match the parent generation' using errcode='55000';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(v_children) as child(item)
      where upper(coalesce(item->>'commandType','')) <> 'PLACE_ORDER'
        or upper(coalesce(item->'payload'->>'action','')) <> 'TAKE_PROFIT'
        or item->'payload'->>'parentEntryIdempotencyKey' <> v_parent_key
        or nullif(btrim(item->'payload'->>'targetId'),'') is null
    ) then
      raise exception 'direct strategy TP manifest is not linked to its immutable parent/action generation' using errcode='55000';
    end if;
  else
    v_parent_group_intent_id := nullif(p_parent_command->>'groupIntentId','')::uuid;
    if v_parent_group_intent_id is null then
      raise exception 'group strategy parent intent is required' using errcode='22023';
    end if;
    select least(7,coalesce(jsonb_array_length(i.strategy_execution_policy->'takeProfits'),0))
      into v_expected_children
    from public.group_trade_intents i
    where i.id=v_parent_group_intent_id
      and i.strategy_automation_id=p_strategy_id
      and i.strategy_target_binding_id=p_binding_id
      and i.strategy_action='SYNC_DIRECTION';
    if v_expected_children is null then
      raise exception 'group strategy parent intent is missing or not owned by this generation' using errcode='55000';
    end if;
    if v_child_count <> v_expected_children then
      raise exception 'group strategy TP manifest count does not match the parent generation' using errcode='55000';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(v_children) as child(item)
      left join public.group_trade_intents i on i.id=nullif(child.item->>'groupIntentId','')::uuid
      where upper(coalesce(child.item->>'commandType','')) <> 'EXPAND_GROUP_INTENT'
        or i.id is null
        or i.strategy_action <> 'TAKE_PROFIT'
        or i.strategy_automation_id is distinct from p_strategy_id
        or i.strategy_target_binding_id is distinct from p_binding_id
        or i.strategy_execution_policy->>'parentGroupIntentId' <> v_parent_group_intent_id::text
    ) then
      raise exception 'group strategy TP manifest is not linked to its parent generation' using errcode='55000';
    end if;
  end if;

  for v_command in select item from jsonb_array_elements(v_commands) as manifest(item)
  loop
    if upper(coalesce(v_command->>'commandType','')) <> v_parent_type
      or nullif(btrim(v_command->>'strategySignalKey'),'') is null
      or coalesce((v_command->>'priority')::integer,0) < 0
      or coalesce((v_command->>'maxAttempts')::integer,0) not between 1 and 100
      or coalesce(jsonb_typeof(v_command->'payload'),'null') <> 'object' then
      raise exception 'strategy generation command shape is invalid' using errcode='22023';
    end if;
    if v_target_type='BROKER_ACCOUNT' and (
      nullif(v_command->>'userId','')::uuid is distinct from v_owner_user_id
      or nullif(v_command->>'connectionId','')::uuid is distinct from v_binding_connection_id
      or nullif(v_command->>'groupIntentId','') is not null
    ) then
      raise exception 'direct strategy command authority does not match its binding' using errcode='42501';
    end if;
    if v_target_type='INVESTMENT_GROUP' and (
      nullif(v_command->>'userId','') is not null
      or nullif(v_command->>'connectionId','') is not null
      or not exists (
        select 1 from public.group_trade_intents i
        where i.id=nullif(v_command->>'groupIntentId','')::uuid
          and i.group_id=v_binding_group_id
          and i.strategy_automation_id=p_strategy_id
          and i.strategy_target_binding_id=p_binding_id
      )
    ) then
      raise exception 'group strategy command authority does not match its binding' using errcode='42501';
    end if;

    insert into public.execution_commands(
      command_type,user_id,connection_id,group_intent_id,
      strategy_automation_id,strategy_target_binding_id,strategy_signal_key,
      idempotency_key,deterministic_client_order_id,payload,status,priority,
      max_attempts,available_at
    ) values (
      v_parent_type,
      nullif(v_command->>'userId','')::uuid,
      nullif(v_command->>'connectionId','')::uuid,
      nullif(v_command->>'groupIntentId','')::uuid,
      p_strategy_id,p_binding_id,v_command->>'strategySignalKey',
      v_command->>'idempotencyKey',nullif(v_command->>'deterministicClientOrderId',''),
      v_command->'payload','QUEUED',(v_command->>'priority')::integer,
      (v_command->>'maxAttempts')::integer,now()
    )
    on conflict (idempotency_key) do nothing;
  end loop;

  -- Existing rows are allowed only when every immutable field is identical.
  -- This makes a retry idempotent while rejecting a reused key or partial
  -- generation belonging to different execution authority.
  select count(*) into v_actual
  from jsonb_array_elements(v_commands) as manifest(item)
  join public.execution_commands c on c.idempotency_key=manifest.item->>'idempotencyKey'
  where c.strategy_automation_id=p_strategy_id
    and c.strategy_target_binding_id=p_binding_id
    and c.command_type=upper(manifest.item->>'commandType')
    and c.user_id is not distinct from nullif(manifest.item->>'userId','')::uuid
    and c.connection_id is not distinct from nullif(manifest.item->>'connectionId','')::uuid
    and c.group_intent_id is not distinct from nullif(manifest.item->>'groupIntentId','')::uuid
    and c.strategy_signal_key=manifest.item->>'strategySignalKey'
    and c.deterministic_client_order_id is not distinct from nullif(manifest.item->>'deterministicClientOrderId','')
    -- Execution reconciliation may append durable protection metadata after
    -- claim. The original signed command fields must still be present, while
    -- those monotonic worker annotations must not break enqueue idempotency.
    and c.payload @> (manifest.item->'payload')
    and c.priority=(manifest.item->>'priority')::integer
    and c.max_attempts=(manifest.item->>'maxAttempts')::integer;
  if v_actual <> v_expected then
    raise exception 'strategy generation idempotency conflict or ownership mismatch' using errcode='23505';
  end if;

  -- Also repairs a complete generation left staged by the previous worker
  -- implementation. The update is harmless for an already claimed/terminal
  -- idempotent retry and makes a zero-child CLOSE immediately claimable.
  update public.execution_commands c
  set available_at=now(),updated_at=now()
  where c.idempotency_key in (
      select item->>'idempotencyKey' from jsonb_array_elements(v_commands) as manifest(item)
    )
    and c.status='QUEUED'
    and c.attempt_count=0
    and c.execution_order_id is null
    and c.available_at > now();

  return v_expected;
end;
$$;

revoke all on function public.black_cloud_enqueue_strategy_generation_v1(uuid,uuid,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.black_cloud_enqueue_strategy_generation_v1(uuid,uuid,jsonb,jsonb)
  to service_role;

comment on function public.black_cloud_enqueue_strategy_generation_v1(uuid,uuid,jsonb,jsonb)
  is 'Atomically inserts and validates one idempotent Strategy Lab parent plus zero to seven TP commands before any command is claimable.';

-- Backward-repair boundary for a complete generation staged by an older
-- strategy worker. New workers use black_cloud_enqueue_strategy_generation_v1.
create or replace function public.black_cloud_release_strategy_generation_v1(
  p_strategy_id uuid,
  p_binding_id uuid,
  p_parent_idempotency_key text,
  p_child_idempotency_keys text[] default array[]::text[]
)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_children text[] := coalesce(p_child_idempotency_keys,array[]::text[]);
  v_keys text[];
  v_expected integer;
  v_locked integer;
  v_unique integer;
  v_parent public.execution_commands%rowtype;
  v_expected_children integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'execution service identity required' using errcode='42501';
  end if;
  if p_strategy_id is null or p_binding_id is null or nullif(btrim(p_parent_idempotency_key),'') is null then
    raise exception 'strategy generation identity is required' using errcode='22023';
  end if;
  if cardinality(v_children) > 7
    or exists (select 1 from unnest(v_children) as child(value) where nullif(btrim(child.value),'') is null) then
    raise exception 'strategy generation child manifest is invalid' using errcode='22023';
  end if;

  v_keys := array[p_parent_idempotency_key] || v_children;
  v_expected := cardinality(v_keys);
  select count(distinct key) into v_unique from unnest(v_keys) as item(key);
  if v_unique <> v_expected then
    raise exception 'strategy generation idempotency keys must be unique' using errcode='22023';
  end if;

  -- Lock in deterministic key order so concurrent checkpoint repair attempts
  -- serialize without deadlocking one another.
  perform c.id
  from public.execution_commands c
  where c.idempotency_key=any(v_keys)
  order by c.idempotency_key
  for update;
  get diagnostics v_locked = row_count;
  if v_locked <> v_expected then
    raise exception 'strategy generation manifest is incomplete: expected %, found %',v_expected,v_locked using errcode='55000';
  end if;

  select c.* into strict v_parent
  from public.execution_commands c
  where c.idempotency_key=p_parent_idempotency_key;
  if v_parent.strategy_automation_id is distinct from p_strategy_id
    or v_parent.strategy_target_binding_id is distinct from p_binding_id
    or v_parent.command_type not in ('PLACE_ORDER','EXPAND_GROUP_INTENT') then
    raise exception 'strategy generation parent ownership is invalid' using errcode='42501';
  end if;
  if exists (
    select 1 from public.execution_commands c
    where c.idempotency_key=any(v_children)
      and (
        c.strategy_automation_id is distinct from p_strategy_id
        or c.strategy_target_binding_id is distinct from p_binding_id
        or c.command_type is distinct from v_parent.command_type
      )
  ) then
    raise exception 'strategy generation child ownership is invalid' using errcode='42501';
  end if;

  if v_parent.command_type='PLACE_ORDER' then
    if upper(coalesce(v_parent.payload->>'action','')) in ('ENTRY','REVERSE') then
      v_expected_children := least(7,coalesce(jsonb_array_length(v_parent.payload->'takeProfits'),0));
    else
      v_expected_children := 0;
    end if;
    if cardinality(v_children) <> v_expected_children then
      raise exception 'direct strategy TP manifest count does not match the parent generation' using errcode='55000';
    end if;
    if exists (
      select 1 from public.execution_commands c
      where c.idempotency_key=any(v_children)
        and (
          upper(coalesce(c.payload->>'action','')) <> 'TAKE_PROFIT'
          or c.payload->>'parentEntryIdempotencyKey' <> p_parent_idempotency_key
        )
    ) then
      raise exception 'direct strategy TP manifest is not linked to its parent generation' using errcode='55000';
    end if;
  else
    select least(7,coalesce(jsonb_array_length(i.strategy_execution_policy->'takeProfits'),0))
      into v_expected_children
    from public.group_trade_intents i
    where i.id=v_parent.group_intent_id
      and i.strategy_automation_id=p_strategy_id
      and i.strategy_target_binding_id=p_binding_id
      and i.strategy_action='SYNC_DIRECTION';
    if v_expected_children is null or cardinality(v_children) <> v_expected_children then
      raise exception 'group strategy TP manifest count does not match the parent generation' using errcode='55000';
    end if;
    if exists (
      select 1
      from public.execution_commands c
      left join public.group_trade_intents i on i.id=c.group_intent_id
      where c.idempotency_key=any(v_children)
        and (
          i.id is null
          or i.strategy_action <> 'TAKE_PROFIT'
          or i.strategy_automation_id is distinct from p_strategy_id
          or i.strategy_target_binding_id is distinct from p_binding_id
          or i.strategy_execution_policy->>'parentGroupIntentId' <> v_parent.group_intent_id::text
        )
    ) then
      raise exception 'group strategy TP manifest is not linked to its parent generation' using errcode='55000';
    end if;
  end if;

  update public.execution_commands c
  set available_at=now(),updated_at=now()
  where c.idempotency_key=any(v_keys)
    and c.status='QUEUED'
    and c.attempt_count=0
    and c.execution_order_id is null
    and c.available_at > now();

  return v_expected;
end;
$$;

revoke all on function public.black_cloud_release_strategy_generation_v1(uuid,uuid,text,text[])
  from public,anon,authenticated;
grant execute on function public.black_cloud_release_strategy_generation_v1(uuid,uuid,text,text[])
  to service_role;

comment on function public.black_cloud_release_strategy_generation_v1(uuid,uuid,text,text[])
  is 'Atomically releases a complete direct or Investment Group strategy command generation after validating every TP child.';

commit;
