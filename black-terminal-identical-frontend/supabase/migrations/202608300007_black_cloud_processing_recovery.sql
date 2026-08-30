-- Recover execution work orphaned by a worker restart without ever blindly
-- duplicating a possibly acknowledged venue mutation. A still-running owner
-- keeps its command even after the row lock clock passes; only work without a
-- matching live lease + STARTED attempt is recovered.
begin;

create or replace function public.black_cloud_claim_execution_commands(
  p_worker_id text,
  p_limit integer default 10,
  p_lock_seconds integer default 300,
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

  -- Mark an abandoned in-flight attempt before returning its command to the
  -- queue. Order mutations enter SUBMISSION_UNKNOWN so the deterministic
  -- client order ID is queried before any possible resubmission.
  update public.execution_command_attempts a set
    outcome=case when c.command_type in ('PLACE_ORDER','MODIFY_ORDER','CANCEL_ORDER','CANCEL_ALL')
      then 'SUBMISSION_UNKNOWN' else 'RETRY' end,
    error_code='PROCESSING_LEASE_EXPIRED',
    error_message='The prior worker lost execution ownership before completing the durable command.',
    safe_details=coalesce(a.safe_details,'{}'::jsonb) || jsonb_build_object('recoveredBy',p_worker_id),
    completed_at=now()
  from public.execution_commands c
  where a.command_id=c.id
    and a.attempt_number=c.attempt_count
    and a.outcome='STARTED'
    and c.status='PROCESSING'
    and c.locked_until <= now()
    and (c.execution_environment=p_execution_environment or (p_claim_global and c.connection_id is null))
    and not exists (
      select 1
      from public.worker_leases l
      where l.lease_key=case when c.connection_id is null
        then 'global:group-intents'
        else 'connection:' || c.connection_id::text end
        and l.worker_id=c.locked_by
        and l.expires_at > now()
        and a.worker_id=c.locked_by
        and a.fencing_token=l.fencing_token
    );

  update public.execution_commands c set
    status=case when c.command_type in ('PLACE_ORDER','MODIFY_ORDER','CANCEL_ORDER','CANCEL_ALL')
      then 'SUBMISSION_UNKNOWN' else 'RETRY' end,
    available_at=now(),
    locked_by=null,
    locked_until=null,
    fencing_token=null,
    last_error_code=coalesce(c.last_error_code,'PROCESSING_LEASE_EXPIRED'),
    last_error_message=coalesce(c.last_error_message,'The prior worker lost execution ownership; deterministic reconciliation is required.'),
    completed_at=null,
    updated_at=now()
  where c.status='PROCESSING'
    and c.locked_until <= now()
    and (c.execution_environment=p_execution_environment or (p_claim_global and c.connection_id is null))
    and not exists (
      select 1
      from public.execution_command_attempts a
      join public.worker_leases l
        on l.lease_key=case when c.connection_id is null
          then 'global:group-intents'
          else 'connection:' || c.connection_id::text end
      where a.command_id=c.id
        and a.attempt_number=c.attempt_count
        and a.outcome='STARTED'
        and a.worker_id=c.locked_by
        and a.fencing_token=l.fencing_token
        and l.worker_id=c.locked_by
        and l.expires_at > now()
    );

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
    locked_until=now()+make_interval(secs=>greatest(30,least(p_lock_seconds,300))),
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

comment on function public.black_cloud_claim_execution_commands(text,integer,integer,text,boolean)
  is 'Claims isolated execution commands with restart-safe orphan recovery and deterministic venue reconciliation.';

commit;
