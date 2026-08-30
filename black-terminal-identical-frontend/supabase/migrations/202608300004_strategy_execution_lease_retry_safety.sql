-- Keep connection-lease contention from consuming broker-command attempts.
-- A queue claim happens before the per-connection execution lease is acquired;
-- during rolling restarts two workers can therefore contend for the same
-- boundary. Contention is not an execution attempt and must not exhaust the
-- command before the incumbent lease expires.
begin;

create or replace function public.black_cloud_release_execution_command_lease_contention(
  p_command_id uuid,
  p_worker_id text,
  p_retry_after_seconds integer default 2
)
returns public.execution_commands
language plpgsql
security definer
set search_path=public
as $$
declare
  released_command public.execution_commands;
  observed_id uuid;
  observed_status text;
  observed_worker text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'execution service identity required' using errcode='42501';
  end if;

  select c.id,c.status,c.locked_by
  into observed_id,observed_status,observed_worker
  from public.execution_commands c
  where c.id=p_command_id
  for update;

  if observed_id is null
     or observed_status <> 'PROCESSING'
     or observed_worker is distinct from p_worker_id then
    raise exception 'command ownership lost' using errcode='40001';
  end if;

  update public.execution_commands as c set
    status='RETRY',
    attempt_count=greatest(0,c.attempt_count-1),
    available_at=now()+make_interval(secs=>greatest(0,least(coalesce(p_retry_after_seconds,2),300))),
    locked_by=null,
    locked_until=null,
    fencing_token=null,
    last_error_code='LEASE_BUSY',
    last_error_message='Another worker owns this execution boundary.',
    completed_at=null,
    updated_at=now()
  where c.id=observed_id;

  select * into released_command
  from public.execution_commands
  where id=p_command_id;

  return released_command;
end;
$$;

revoke all on function public.black_cloud_release_execution_command_lease_contention(uuid,text,integer)
  from public,anon,authenticated;
grant execute on function public.black_cloud_release_execution_command_lease_contention(uuid,text,integer)
  to service_role;

create or replace function public.black_cloud_claim_execution_commands(
  p_worker_id text,
  p_limit integer default 10,
  p_lock_seconds integer default 45,
  p_execution_environment text default null,
  p_claim_global boolean default false
)
returns setof public.execution_commands
language plpgsql
security definer
set search_path=public
as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'execution service identity required' using errcode='42501';
  end if;
  if p_execution_environment is null or p_execution_environment not in ('DEMO','MAINNET_LIVE') then
    raise exception 'worker execution environment is required' using errcode='22023';
  end if;

  -- A RETRY row at its true attempt limit is terminal. Sweep it before
  -- selecting candidates so it cannot remain permanently invisible to every
  -- worker while still presenting as retryable to operators.
  update public.execution_commands c set
    status='DEAD_LETTER',
    locked_by=null,
    locked_until=null,
    completed_at=coalesce(c.completed_at,now()),
    last_error_code=coalesce(c.last_error_code,'MAX_ATTEMPTS_EXHAUSTED'),
    last_error_message=coalesce(c.last_error_message,'Execution retry budget exhausted.'),
    updated_at=now()
  where c.status='RETRY'
    and c.attempt_count >= c.max_attempts
    and (c.locked_until is null or c.locked_until <= now())
    and (c.execution_environment=p_execution_environment or (p_claim_global and c.connection_id is null));

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
    status='PROCESSING',
    locked_by=p_worker_id,
    locked_until=now()+make_interval(secs=>greatest(10,least(p_lock_seconds,300))),
    attempt_count=c.attempt_count+1,
    updated_at=now()
  from candidates x
  where c.id=x.id
  returning c.*;
end;
$$;

revoke all on function public.black_cloud_claim_execution_commands(text,integer,integer,text,boolean)
  from public,anon,authenticated;
grant execute on function public.black_cloud_claim_execution_commands(text,integer,integer,text,boolean)
  to service_role;

comment on function public.black_cloud_release_execution_command_lease_contention(uuid,text,integer)
  is 'Requeues a command after connection-lease contention without consuming a broker execution attempt.';

commit;
