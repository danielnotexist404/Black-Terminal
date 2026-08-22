-- Strategy Lab UX reconstruction: separate mutable drafts, immutable published
-- versions, and the explicitly selected Paper runtime version. Existing
-- strategies are backfilled without changing their active Paper behavior.
begin;

alter table public.strategy_automation_strategies
  add column if not exists draft_name text,
  add column if not exists draft_definition jsonb,
  add column if not exists draft_revision integer not null default 0,
  add column if not exists draft_base_version integer,
  add column if not exists draft_updated_at timestamptz,
  add column if not exists published_version integer,
  add column if not exists running_version integer;

alter table public.strategy_automation_runtime_state
  add column if not exists running_version integer;

update public.strategy_automation_strategies
set draft_name=coalesce(draft_name,name),
    draft_definition=coalesce(draft_definition,definition),
    draft_base_version=coalesce(draft_base_version,current_version),
    draft_updated_at=coalesce(draft_updated_at,updated_at),
    published_version=case when status='DRAFT' then published_version else coalesce(published_version,current_version) end,
    running_version=case when status='DRAFT' then running_version else coalesce(running_version,current_version) end
where published_version is null or running_version is null or draft_definition is null;

update public.strategy_automation_runtime_state r
set running_version=s.running_version
from public.strategy_automation_strategies s
where s.id=r.strategy_id and r.running_version is null;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='strategy_draft_name_length') then
    alter table public.strategy_automation_strategies add constraint strategy_draft_name_length
      check(draft_name is null or length(btrim(draft_name)) between 1 and 80);
  end if;
  if not exists(select 1 from pg_constraint where conname='strategy_draft_definition_object') then
    alter table public.strategy_automation_strategies add constraint strategy_draft_definition_object
      check(draft_definition is null or jsonb_typeof(draft_definition)='object');
  end if;
  if not exists(select 1 from pg_constraint where conname='strategy_draft_revision_nonnegative') then
    alter table public.strategy_automation_strategies add constraint strategy_draft_revision_nonnegative
      check(draft_revision>=0);
  end if;
end $$;

create or replace function public.black_core_create_strategy_draft(
  p_owner_user_id uuid,
  p_name text,
  p_definition jsonb,
  p_global_policy jsonb,
  p_canonical_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare existing_row public.strategy_automation_strategies; created_row public.strategy_automation_strategies;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if length(btrim(p_name)) not between 1 and 80 then raise exception 'invalid strategy name' using errcode='22023'; end if;
  if jsonb_typeof(p_definition)<>'object' or length(p_canonical_hash)<>64 then raise exception 'invalid strategy draft' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-draft-create:'||p_owner_user_id::text||':'||p_idempotency_key,0));
  select * into existing_row from public.strategy_automation_strategies where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if existing_row.id is not null then
    if existing_row.request_hash<>p_canonical_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('strategyId',existing_row.id,'draftRevision',existing_row.draft_revision,'idempotent',true);
  end if;
  insert into public.strategy_automation_strategies(
    owner_user_id,name,runtime_kind,symbol,timeframe,market_type,exchange,current_version,definition,global_capital_policy,status,
    idempotency_key,request_hash,draft_name,draft_definition,draft_revision,draft_base_version,draft_updated_at,published_version,running_version
  ) values(
    p_owner_user_id,btrim(p_name),p_definition->>'runtimeKind',p_definition->>'symbol',p_definition->>'timeframe',p_definition->>'marketType',coalesce(p_definition->>'exchange','bybit'),
    1,p_definition,p_global_policy,'DRAFT',p_idempotency_key,p_canonical_hash,btrim(p_name),p_definition,1,null,now(),null,null
  ) returning * into created_row;
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,created_row.id,'STRATEGY_DRAFT_CREATED','A server-side strategy draft was created.',jsonb_build_object('draftRevision',1,'liveTargetRows',0));
  return jsonb_build_object('strategyId',created_row.id,'draftRevision',1,'idempotent',false);
end;
$$;

create or replace function public.black_core_save_strategy_draft(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_name text,
  p_definition jsonb,
  p_expected_revision integer
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare strategy_row public.strategy_automation_strategies; next_revision integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if length(btrim(p_name)) not between 1 and 80 or jsonb_typeof(p_definition)<>'object' then raise exception 'invalid strategy draft' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-draft-save:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  if p_expected_revision is not null and strategy_row.draft_revision<>p_expected_revision then raise exception 'strategy draft revision conflict' using errcode='40001'; end if;
  next_revision:=strategy_row.draft_revision+1;
  update public.strategy_automation_strategies set
    draft_name=btrim(p_name),draft_definition=p_definition,draft_revision=next_revision,draft_updated_at=now(),
    name=case when published_version is null then btrim(p_name) else name end,
    runtime_kind=case when published_version is null then p_definition->>'runtimeKind' else runtime_kind end,
    symbol=case when published_version is null then p_definition->>'symbol' else symbol end,
    timeframe=case when published_version is null then p_definition->>'timeframe' else timeframe end,
    market_type=case when published_version is null then p_definition->>'marketType' else market_type end,
    exchange=case when published_version is null then coalesce(p_definition->>'exchange','bybit') else exchange end,
    definition=case when published_version is null then p_definition else definition end
  where id=p_strategy_id;
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'STRATEGY_DRAFT_SAVED','Draft changes were saved without changing the published or running version.',jsonb_build_object('draftRevision',next_revision,'publishedVersion',strategy_row.published_version,'runningVersion',strategy_row.running_version));
  return jsonb_build_object('strategyId',p_strategy_id,'draftRevision',next_revision);
end;
$$;

create or replace function public.black_core_publish_strategy_draft(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_expected_revision integer,
  p_global_policy jsonb,
  p_paper_policy jsonb,
  p_canonical_hash text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare strategy_row public.strategy_automation_strategies; next_version integer; latest_hash text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if length(p_canonical_hash)<>64 then raise exception 'invalid strategy hash' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-publish:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  if strategy_row.draft_definition is null then raise exception 'strategy draft missing' using errcode='22023'; end if;
  if strategy_row.draft_revision<>p_expected_revision then raise exception 'strategy draft revision conflict' using errcode='40001'; end if;
  if strategy_row.published_version is not null then
    select canonical_hash into latest_hash from public.strategy_automation_versions where strategy_id=p_strategy_id and version=strategy_row.published_version;
    if latest_hash=p_canonical_hash then return jsonb_build_object('strategyId',p_strategy_id,'publishedVersion',strategy_row.published_version,'idempotent',true); end if;
  end if;
  next_version:=coalesce(strategy_row.published_version,0)+1;
  insert into public.strategy_automation_versions(strategy_id,owner_user_id,version,name,definition,global_capital_policy,canonical_hash)
  values(p_strategy_id,p_owner_user_id,next_version,strategy_row.draft_name,strategy_row.draft_definition,p_global_policy,p_canonical_hash);
  insert into public.strategy_paper_accounts(strategy_id,strategy_version,owner_user_id,market_type,status,capital_policy)
  values(p_strategy_id,next_version,p_owner_user_id,strategy_row.draft_definition->>'marketType','PAUSED',p_paper_policy);
  update public.strategy_automation_strategies set
    name=strategy_row.draft_name,runtime_kind=strategy_row.draft_definition->>'runtimeKind',symbol=strategy_row.draft_definition->>'symbol',
    timeframe=strategy_row.draft_definition->>'timeframe',market_type=strategy_row.draft_definition->>'marketType',
    exchange=coalesce(strategy_row.draft_definition->>'exchange','bybit'),definition=strategy_row.draft_definition,
    global_capital_policy=p_global_policy,current_version=next_version,published_version=next_version,
    draft_base_version=next_version,draft_updated_at=now(),status=case when strategy_row.running_version is null then 'PAPER_PAUSED' else strategy_row.status end
  where id=p_strategy_id;
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'STRATEGY_VERSION_PUBLISHED','An immutable strategy version was published without changing the running Paper version.',
    jsonb_build_object('publishedVersion',next_version,'runningVersion',strategy_row.running_version,'liveTargetRowsCreated',0));
  return jsonb_build_object('strategyId',p_strategy_id,'publishedVersion',next_version,'runningVersion',strategy_row.running_version,'idempotent',false);
end;
$$;

create or replace function public.black_core_start_strategy_version(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_version integer
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare strategy_row public.strategy_automation_strategies; version_row public.strategy_automation_versions; old_paper uuid; open_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-start-version:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  select * into version_row from public.strategy_automation_versions where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id and version=p_version;
  if version_row.id is null then raise exception 'strategy version missing' using errcode='22023'; end if;
  if strategy_row.running_version is not null and strategy_row.running_version<>p_version then
    select id into old_paper from public.strategy_paper_accounts where strategy_id=p_strategy_id and strategy_version=strategy_row.running_version;
    select count(*) into open_count from public.strategy_paper_positions where paper_account_id=old_paper and closed_at is null;
    if open_count>0 then raise exception 'running paper version has an open position' using errcode='55000'; end if;
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
  values(p_owner_user_id,p_strategy_id,'STRATEGY_RUNTIME_VERSION_STARTED','The selected published version became the Paper runtime after an explicit transition.',jsonb_build_object('previousVersion',strategy_row.running_version,'runningVersion',p_version));
  return jsonb_build_object('strategyId',p_strategy_id,'runningVersion',p_version);
end;
$$;

revoke all on function public.black_core_create_strategy_draft(uuid,text,jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.black_core_save_strategy_draft(uuid,uuid,text,jsonb,integer) from public,anon,authenticated;
revoke all on function public.black_core_publish_strategy_draft(uuid,uuid,integer,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.black_core_start_strategy_version(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.black_core_create_strategy_draft(uuid,text,jsonb,jsonb,text,text) to service_role;
grant execute on function public.black_core_save_strategy_draft(uuid,uuid,text,jsonb,integer) to service_role;
grant execute on function public.black_core_publish_strategy_draft(uuid,uuid,integer,jsonb,jsonb,text) to service_role;
grant execute on function public.black_core_start_strategy_version(uuid,uuid,integer) to service_role;

commit;
