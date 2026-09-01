-- Immutable owned-script snapshots for the headless Black Script v3 worker.
-- The browser never receives another user's source and cannot mutate a pinned
-- running version. The service-role worker verifies the saved source identity
-- before first pinning it and fails closed on every mismatch.
begin;

create table if not exists public.strategy_script_artifacts (
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  strategy_version integer not null check (strategy_version > 0),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  script_id text not null check (length(btrim(script_id)) between 1 and 160),
  runtime_version text not null default 'black-script-v3' check (runtime_version = 'black-script-v3'),
  source_version text not null check (source_version ~ '^[0-9a-f]{8}$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source text not null check (length(source) between 1 and 100000),
  created_at timestamptz not null default now(),
  primary key (strategy_id, strategy_version),
  unique (strategy_id, strategy_version, source_sha256)
);

create index if not exists idx_strategy_script_artifacts_owner
  on public.strategy_script_artifacts(owner_user_id, created_at desc);

-- Per-target OMS state is deliberately separate from the deterministic
-- strategy checkpoint. A single script may fan out to nine accounts and each
-- venue can acknowledge, partially fill or reject a resting order at a
-- different time. Keeping the handles here prevents one account's broker state
-- from corrupting the shared confirmed-bar strategy state.
create table if not exists public.strategy_script_target_state (
  binding_id uuid primary key references public.strategy_target_bindings(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  strategy_version integer not null check (strategy_version > 0),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  source_version text not null check (source_version ~ '^[0-9a-f]{8}$'),
  settings_version text not null check (settings_version ~ '^[0-9a-f]{8}$'),
  last_generation_key text not null check (length(last_generation_key) between 16 and 512),
  last_generation_candle_time bigint not null check (last_generation_candle_time > 0),
  desired_order_fingerprints jsonb not null default '{}'::jsonb check (jsonb_typeof(desired_order_fingerprints) = 'object'),
  broker_order_handles jsonb not null default '{}'::jsonb check (jsonb_typeof(broker_order_handles) = 'object'),
  synchronization_state text not null default 'PENDING' check (synchronization_state in ('PENDING','IN_SYNC','DEGRADED','PAUSED')),
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique (strategy_id, strategy_version, binding_id)
);

create index if not exists idx_strategy_script_target_state_strategy
  on public.strategy_script_target_state(strategy_id, strategy_version, updated_at desc);

alter table public.execution_commands
  drop constraint if exists execution_commands_strategy_shape_check;
alter table public.execution_commands
  add constraint execution_commands_strategy_shape_check check (
    (strategy_target_binding_id is null and strategy_automation_id is null and strategy_signal_key is null)
    or
    (
      command_type in ('PLACE_ORDER','EXPAND_GROUP_INTENT','MODIFY_ORDER','CANCEL_ORDER','PLACE_PROTECTION')
      and strategy_target_binding_id is not null
      and strategy_automation_id is not null
      and length(strategy_signal_key) between 16 and 512
    )
  );

alter table public.strategy_script_artifacts enable row level security;
alter table public.strategy_script_target_state enable row level security;
revoke all on public.strategy_script_artifacts from anon, authenticated;
revoke all on public.strategy_script_target_state from anon, authenticated;
grant all on public.strategy_script_artifacts to service_role;
grant all on public.strategy_script_target_state to service_role;

-- Persist one complete confirmed-candle generation and its commands in the
-- same PostgreSQL transaction. Commands are invisible to the execution worker
-- until this function commits, and the strategy checkpoint cannot advance if
-- any target command fails ownership or idempotency validation.
create or replace function public.black_cloud_commit_script_generation_v1(
  p_strategy_id uuid,
  p_owner_user_id uuid,
  p_worker_id text,
  p_expected_state_version bigint,
  p_running_version integer,
  p_last_closed_candle_at timestamptz,
  p_checkpoint jsonb,
  p_source_sha256 text,
  p_settings_sha256 text,
  p_target_manifests jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_runtime public.strategy_automation_runtime_state%rowtype;
  v_strategy public.strategy_automation_strategies%rowtype;
  v_artifact public.strategy_script_artifacts%rowtype;
  v_manifest jsonb;
  v_command jsonb;
  v_binding public.strategy_target_bindings%rowtype;
  v_commands jsonb;
  v_binding_id uuid;
  v_command_count integer := 0;
  v_expected integer := 0;
  v_actual integer := 0;
  v_unique integer := 0;
  v_updated integer := 0;
  v_generation_key text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'execution service identity required' using errcode='42501';
  end if;
  if p_strategy_id is null or p_owner_user_id is null
    or nullif(btrim(p_worker_id),'') is null
    or p_expected_state_version is null or p_running_version is null
    or p_last_closed_candle_at is null
    or jsonb_typeof(p_checkpoint) <> 'object'
    or jsonb_typeof(coalesce(p_target_manifests,'[]'::jsonb)) <> 'array'
    or coalesce(p_source_sha256,'') !~ '^[0-9a-f]{64}$'
    or coalesce(p_settings_sha256,'') !~ '^[0-9a-f]{64}$'
    or coalesce(p_checkpoint->>'runtimeVersion','') <> 'black-script-v3'
    or coalesce(p_checkpoint->>'sourceVersion','') !~ '^[0-9a-f]{8}$'
    or coalesce(p_checkpoint->>'settingsVersion','') !~ '^[0-9a-f]{8}$'
    or coalesce((p_checkpoint->>'lastClosedCandleTime')::bigint,0) <= 0 then
    raise exception 'script generation identity, checkpoint and hashes are required' using errcode='22023';
  end if;
  if jsonb_array_length(coalesce(p_target_manifests,'[]'::jsonb)) > 9 then
    raise exception 'script generation may target at most nine bindings' using errcode='22023';
  end if;

  select * into v_strategy
  from public.strategy_automation_strategies s
  where s.id=p_strategy_id and s.owner_user_id=p_owner_user_id and s.archived_at is null
  for update;
  if v_strategy.id is null or v_strategy.runtime_kind <> 'python-script'
    or v_strategy.status not in ('PAPER_ACTIVE','LIVE_READY','LIVE_ACTIVE')
    or v_strategy.running_version is distinct from p_running_version then
    raise exception 'the pinned script strategy version is not running' using errcode='55000';
  end if;

  select * into v_artifact
  from public.strategy_script_artifacts a
  where a.strategy_id=p_strategy_id and a.strategy_version=p_running_version
    and a.owner_user_id=p_owner_user_id
  for share;
  if v_artifact.strategy_id is null
    or v_artifact.runtime_version <> 'black-script-v3'
    or v_artifact.source_sha256 <> p_source_sha256
    or v_artifact.source_version <> p_checkpoint->>'sourceVersion' then
    raise exception 'the immutable Black Script artifact does not match the committed checkpoint' using errcode='55000';
  end if;

  select * into v_runtime
  from public.strategy_automation_runtime_state r
  where r.strategy_id=p_strategy_id and r.owner_user_id=p_owner_user_id
  for update;
  if v_runtime.strategy_id is null
    or v_runtime.state_version is distinct from p_expected_state_version
    or v_runtime.running_version is distinct from p_running_version
    or v_runtime.lease_owner is distinct from p_worker_id
    or v_runtime.lease_expires_at is null or v_runtime.lease_expires_at <= now() then
    raise exception 'script runtime lease or fencing version changed' using errcode='40001';
  end if;
  if v_runtime.last_closed_candle_at is not null and p_last_closed_candle_at < v_runtime.last_closed_candle_at then
    raise exception 'script checkpoint candle regressed' using errcode='22023';
  end if;

  select count(*),count(distinct nullif(item->>'bindingId','')) into v_actual,v_unique
  from jsonb_array_elements(coalesce(p_target_manifests,'[]'::jsonb)) as target_items(item);
  if v_unique <> v_actual then
    raise exception 'script target bindings must be unique per generation' using errcode='22023';
  end if;

  for v_manifest in
    select item from jsonb_array_elements(coalesce(p_target_manifests,'[]'::jsonb)) as targets(item)
  loop
    if jsonb_typeof(v_manifest) <> 'object'
      or jsonb_typeof(coalesce(v_manifest->'commands','[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(v_manifest->'desiredOrderFingerprints','{}'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(v_manifest->'brokerOrderHandles','{}'::jsonb)) <> 'object' then
      raise exception 'script target manifest shape is invalid' using errcode='22023';
    end if;
    v_binding_id := nullif(v_manifest->>'bindingId','')::uuid;
    v_generation_key := nullif(btrim(v_manifest->>'generationKey'),'');
    if v_binding_id is null or v_generation_key is null or length(v_generation_key) not between 16 and 512 then
      raise exception 'script target generation identity is invalid' using errcode='22023';
    end if;
    if coalesce((v_manifest->>'generationCandleTime')::bigint,0) <= 0
      or (v_manifest->>'generationCandleTime')::bigint is distinct from (p_checkpoint->>'lastClosedCandleTime')::bigint then
      raise exception 'script target generation candle does not match its checkpoint' using errcode='22023';
    end if;
    select * into v_binding
    from public.strategy_target_bindings b
    where b.id=v_binding_id and b.strategy_id=p_strategy_id
      and b.owner_user_id=p_owner_user_id and b.strategy_version=p_running_version
      and b.target_type='BROKER_ACCOUNT' and b.status='LIVE'
    for update;
    if v_binding.id is null or v_binding.connection_id is null or v_binding.account_id is null then
      raise exception 'script target binding authority is invalid' using errcode='42501';
    end if;
    v_commands := coalesce(v_manifest->'commands','[]'::jsonb);
    if jsonb_array_length(v_commands) > 64 then
      raise exception 'one script target generation may contain at most 64 commands' using errcode='22023';
    end if;
    v_expected := v_expected + jsonb_array_length(v_commands);
    if v_expected > 576 then
      raise exception 'script generation command manifest is too large' using errcode='22023';
    end if;

    for v_command in select item from jsonb_array_elements(v_commands) as commands(item)
    loop
      if jsonb_typeof(v_command) <> 'object'
        or upper(coalesce(v_command->>'commandType','')) not in ('PLACE_ORDER','MODIFY_ORDER','CANCEL_ORDER','PLACE_PROTECTION')
        or nullif(btrim(v_command->>'strategySignalKey'),'') is null
        or length(v_command->>'strategySignalKey') not between 16 and 512
        or nullif(btrim(v_command->>'idempotencyKey'),'') is null
        or coalesce(jsonb_typeof(v_command->'payload'),'null') <> 'object'
        or coalesce((v_command->>'priority')::integer,-1) < 0
        or coalesce((v_command->>'maxAttempts')::integer,0) not between 1 and 100
        or nullif(v_command->>'userId','')::uuid is distinct from p_owner_user_id
        or nullif(v_command->>'connectionId','')::uuid is distinct from v_binding.connection_id
        or nullif(v_command->>'groupIntentId','') is not null
        or coalesce(v_command->'payload'->>'blackScriptRuntimeVersion','') <> 'black-script-v3'
        or coalesce(v_command->'payload'->>'sourceVersion','') <> p_checkpoint->>'sourceVersion'
        or coalesce(v_command->'payload'->>'settingsVersion','') <> p_checkpoint->>'settingsVersion'
        or coalesce((v_command->'payload'->>'strategyVersion')::integer,0) <> p_running_version
        or coalesce((v_command->'payload'->>'generationCandleTime')::bigint,0) <> (p_checkpoint->>'lastClosedCandleTime')::bigint
        or not exists (
          select 1 from public.connectivity_connections c
          where c.id=v_binding.connection_id and c.user_id=p_owner_user_id
            and c.account_id=v_binding.account_id
            and c.execution_environment=v_command->'payload'->>'executionEnvironment'
        ) then
        raise exception 'script target command shape or authority is invalid' using errcode='42501';
      end if;
      if upper(v_command->>'commandType')='PLACE_ORDER'
        and nullif(btrim(v_command->>'deterministicClientOrderId'),'') is null then
        raise exception 'script order requires a deterministic client order identity' using errcode='22023';
      end if;

      insert into public.execution_commands(
        command_type,user_id,connection_id,group_intent_id,execution_order_id,
        strategy_automation_id,strategy_target_binding_id,strategy_signal_key,
        idempotency_key,deterministic_client_order_id,payload,status,priority,
        max_attempts,available_at
      ) values (
        upper(v_command->>'commandType'),p_owner_user_id,v_binding.connection_id,null,
        nullif(v_command->>'executionOrderId','')::uuid,
        p_strategy_id,v_binding.id,v_command->>'strategySignalKey',
        v_command->>'idempotencyKey',nullif(v_command->>'deterministicClientOrderId',''),
        v_command->'payload','QUEUED',(v_command->>'priority')::integer,
        (v_command->>'maxAttempts')::integer,now()
      ) on conflict (idempotency_key) do nothing;
      v_command_count := v_command_count + 1;
    end loop;

    select count(distinct item->>'idempotencyKey') into v_unique
    from jsonb_array_elements(v_commands) as command_items(item);
    if v_unique <> jsonb_array_length(v_commands) then
      raise exception 'script command idempotency keys must be unique per target generation' using errcode='22023';
    end if;
    select count(*) into v_actual
    from jsonb_array_elements(v_commands) as manifest_commands(item)
    join public.execution_commands c on c.idempotency_key=manifest_commands.item->>'idempotencyKey'
    where c.strategy_automation_id=p_strategy_id
      and c.strategy_target_binding_id=v_binding.id
      and c.command_type=upper(manifest_commands.item->>'commandType')
      and c.user_id=p_owner_user_id
      and c.connection_id=v_binding.connection_id
      and c.group_intent_id is null
      and c.execution_order_id is not distinct from nullif(manifest_commands.item->>'executionOrderId','')::uuid
      and c.strategy_signal_key=manifest_commands.item->>'strategySignalKey'
      and c.deterministic_client_order_id is not distinct from nullif(manifest_commands.item->>'deterministicClientOrderId','')
      and c.payload = manifest_commands.item->'payload'
      and c.priority=(manifest_commands.item->>'priority')::integer
      and c.max_attempts=(manifest_commands.item->>'maxAttempts')::integer;
    if v_actual <> jsonb_array_length(v_commands) then
      raise exception 'script command idempotency conflict or ownership mismatch' using errcode='23505';
    end if;

    insert into public.strategy_script_target_state(
      binding_id,strategy_id,strategy_version,owner_user_id,source_version,settings_version,
      last_generation_key,last_generation_candle_time,desired_order_fingerprints,broker_order_handles,synchronization_state,last_error_code,updated_at
    ) values (
      v_binding.id,p_strategy_id,p_running_version,p_owner_user_id,
      p_checkpoint->>'sourceVersion',p_checkpoint->>'settingsVersion',v_generation_key,(v_manifest->>'generationCandleTime')::bigint,
      coalesce(v_manifest->'desiredOrderFingerprints','{}'::jsonb),
      coalesce(v_manifest->'brokerOrderHandles','{}'::jsonb),
      case when jsonb_array_length(v_commands)=0 then 'IN_SYNC' else 'PENDING' end,null,now()
    ) on conflict(binding_id) do update set
      strategy_id=excluded.strategy_id,strategy_version=excluded.strategy_version,
      owner_user_id=excluded.owner_user_id,source_version=excluded.source_version,
      settings_version=excluded.settings_version,last_generation_key=excluded.last_generation_key,
      last_generation_candle_time=excluded.last_generation_candle_time,
      desired_order_fingerprints=excluded.desired_order_fingerprints,
      broker_order_handles=excluded.broker_order_handles,synchronization_state=excluded.synchronization_state,
      last_error_code=null,updated_at=now();
  end loop;

  update public.strategy_automation_runtime_state r set
    runtime_state='LIVE',state_version=r.state_version+1,
    last_closed_candle_at=p_last_closed_candle_at,
    pine_checkpoint=p_checkpoint,source_sha256=p_source_sha256,
    settings_sha256=p_settings_sha256,last_heartbeat_at=now(),worker_id=p_worker_id,
    lease_owner=p_worker_id,lease_expires_at=greatest(r.lease_expires_at,now()+interval '15 seconds'),
    safe_error_code=null,updated_at=now()
  where r.strategy_id=p_strategy_id and r.owner_user_id=p_owner_user_id
    and r.state_version=p_expected_state_version and r.running_version=p_running_version
    and r.lease_owner=p_worker_id and r.lease_expires_at>now();
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'script runtime fencing update failed' using errcode='40001';
  end if;
  return v_expected;
end;
$$;

revoke all on function public.black_cloud_commit_script_generation_v1(uuid,uuid,text,bigint,integer,timestamptz,jsonb,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.black_cloud_commit_script_generation_v1(uuid,uuid,text,bigint,integer,timestamptz,jsonb,text,text,jsonb)
  to service_role;

comment on table public.strategy_script_artifacts is
  'Private immutable Black Script source pinned to one published Strategy Lab version for service-role headless execution.';
comment on table public.strategy_script_target_state is
  'Per-binding Black Script desired-order identities and OMS handles; never shared across broker accounts.';
comment on function public.black_cloud_commit_script_generation_v1(uuid,uuid,text,bigint,integer,timestamptz,jsonb,text,text,jsonb) is
  'Atomically commits one fenced Black Script confirmed-candle checkpoint and the complete idempotent direct-broker command manifests for up to nine targets.';
comment on column public.strategy_automation_runtime_state.pine_checkpoint is
  'Server-owned confirmed-bar deterministic runtime checkpoint for certified Pine-compatible and Black Script engines.';

commit;
