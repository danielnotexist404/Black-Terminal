-- Server-authoritative Strategy Lab deletion. A user-facing delete archives
-- the root strategy and retires its inactive runtime state without destroying
-- immutable versions, fills, trades, or audit evidence. Active broker work is
-- fail-closed: it must be paused/disconnected and settled first.
begin;

create table if not exists public.strategy_automation_archive_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid references public.strategy_automation_strategies(id) on delete set null,
  idempotency_key text not null,
  request_hash text not null check (length(request_hash)=64),
  result_snapshot jsonb not null check (jsonb_typeof(result_snapshot)='object'),
  created_at timestamptz not null default now(),
  unique(owner_user_id,idempotency_key)
);

create or replace function public.black_core_archive_strategy(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_expected_name text,
  p_expected_revision integer,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  strategy_row public.strategy_automation_strategies;
  existing_request public.strategy_automation_archive_requests;
  archived_timestamp timestamptz;
  result jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'strategy service identity required' using errcode='42501';
  end if;
  if length(coalesce(p_request_hash,'')) <> 64
     or length(btrim(coalesce(p_idempotency_key,''))) not between 8 and 160
     or length(btrim(coalesce(p_expected_name,''))) not between 1 and 80
     or coalesce(p_expected_revision,-1) < 0 then
    raise exception 'invalid strategy archive request' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('strategy-archive:'||p_strategy_id::text,0));
  select * into existing_request
  from public.strategy_automation_archive_requests
  where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if existing_request.id is not null then
    if existing_request.request_hash<>p_request_hash then
      raise exception 'idempotency key payload mismatch' using errcode='22023';
    end if;
    return existing_request.result_snapshot || jsonb_build_object('idempotent',true);
  end if;

  select * into strategy_row
  from public.strategy_automation_strategies
  where id=p_strategy_id and owner_user_id=p_owner_user_id
  for update;
  if strategy_row.id is null then
    raise exception 'strategy not found' using errcode='P0002';
  end if;

  if strategy_row.archived_at is not null then
    result := jsonb_build_object(
      'strategyId',strategy_row.id,
      'archivedAt',strategy_row.archived_at,
      'idempotent',true
    );
    insert into public.strategy_automation_archive_requests(owner_user_id,strategy_id,idempotency_key,request_hash,result_snapshot)
    values(p_owner_user_id,strategy_row.id,p_idempotency_key,p_request_hash,result);
    return result;
  end if;

  if strategy_row.name<>p_expected_name or strategy_row.draft_revision<>p_expected_revision then
    raise exception 'strategy archive revision conflict' using errcode='40001';
  end if;
  if exists(
    select 1 from public.strategy_target_bindings
    where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id
      and status in ('LIVE','DISCONNECTING')
  ) then
    raise exception 'active strategy targets must be disconnected before archive' using errcode='55000';
  end if;
  if exists(
    select 1 from public.execution_commands
    where strategy_automation_id=p_strategy_id
      and status in ('QUEUED','PROCESSING','RETRY','SUBMISSION_UNKNOWN','RECONCILING')
  ) then
    raise exception 'pending strategy commands must settle before archive' using errcode='55000';
  end if;

  archived_timestamp := now();
  update public.strategy_paper_accounts
  set status='STOPPED',state_version=state_version+1,updated_at=archived_timestamp
  where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id and status<>'STOPPED';

  update public.strategy_target_bindings
  set status='DISCONNECTED',row_version=row_version+1,paused_at=coalesce(paused_at,archived_timestamp),
      disconnected_at=archived_timestamp,disconnect_policy=coalesce(disconnect_policy,'KEEP_PROTECTED'),updated_at=archived_timestamp
  where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id and status<>'DISCONNECTED';

  update public.strategy_automation_runtime_state
  set runtime_state='STOPPED',state_version=state_version+1,last_heartbeat_at=archived_timestamp,
      lease_owner=null,lease_expires_at=null,safe_error_code=null,updated_at=archived_timestamp
  where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id;

  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,severity,message,safe_metadata)
  values(
    p_owner_user_id,p_strategy_id,'STRATEGY_ARCHIVED','INFO',
    'The user deleted the strategy from My Strategy. Runtime state stopped and immutable history was retained.',
    jsonb_build_object('draftRevision',strategy_row.draft_revision,'publishedVersion',strategy_row.published_version,'runningVersion',strategy_row.running_version,'brokerOrderMutation',false)
  );

  update public.strategy_automation_strategies
  set status='STOPPED',archived_at=archived_timestamp,updated_at=archived_timestamp
  where id=p_strategy_id and owner_user_id=p_owner_user_id;

  result := jsonb_build_object('strategyId',p_strategy_id,'archivedAt',archived_timestamp,'idempotent',false);
  insert into public.strategy_automation_archive_requests(owner_user_id,strategy_id,idempotency_key,request_hash,result_snapshot)
  values(p_owner_user_id,p_strategy_id,p_idempotency_key,p_request_hash,result);
  return result;
end;
$$;

alter table public.strategy_automation_archive_requests enable row level security;
revoke all on public.strategy_automation_archive_requests from anon,authenticated;
revoke all on function public.black_core_archive_strategy(uuid,uuid,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.black_core_archive_strategy(uuid,uuid,text,integer,text,text) to service_role;

comment on function public.black_core_archive_strategy(uuid,uuid,text,integer,text,text)
  is 'Ownership-checked, idempotent Strategy Lab delete. Archives state and preserves immutable execution/audit history; refuses active broker work.';

commit;
