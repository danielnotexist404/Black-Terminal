begin;

-- The table-returning function exposes OUT variables named fencing_epoch and
-- lease_expires_at. PostgreSQL therefore requires table aliases anywhere the
-- underlying columns use the same names. Keep the lease state machine and
-- service-role boundary unchanged; only remove PL/pgSQL name ambiguity.
create or replace function public.bclif_acquire_collector_lease(
  p_node_id text,
  p_instance_id text,
  p_lease_ttl_ms integer
)
returns table(fencing_epoch bigint, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  locked_node public.bclif_collector_nodes%rowtype;
  instance_node_id text;
  next_epoch bigint;
  next_expiry timestamptz;
begin
  if p_lease_ttl_ms < 5000 or p_lease_ttl_ms > 300000 then
    raise exception 'BCLIF lease TTL is outside the safe bound' using errcode = '22023';
  end if;
  select collector_node.* into locked_node
  from public.bclif_collector_nodes as collector_node
  where collector_node.node_id = p_node_id
  for update;
  if not found then
    raise exception 'BCLIF collector node is not registered' using errcode = 'P0002';
  end if;
  select collector_instance.node_id into instance_node_id
  from public.bclif_collector_instances as collector_instance
  where collector_instance.instance_id = p_instance_id;
  if instance_node_id is distinct from p_node_id then
    raise exception 'BCLIF collector instance does not belong to this node' using errcode = '28000';
  end if;
  if locked_node.current_instance_id = p_instance_id
     and locked_node.lease_expires_at > clock_timestamp() then
    next_epoch := locked_node.fencing_epoch;
  elsif locked_node.current_instance_id is not null
        and locked_node.current_instance_id <> p_instance_id
        and locked_node.lease_expires_at > clock_timestamp() then
    raise exception 'BCLIF collector authority lease is already held' using errcode = '55P03';
  else
    next_epoch := locked_node.fencing_epoch + 1;
  end if;
  next_expiry := clock_timestamp() + make_interval(secs => p_lease_ttl_ms::double precision / 1000.0);
  update public.bclif_collector_nodes as collector_node
  set current_instance_id = p_instance_id,
      fencing_epoch = next_epoch,
      lease_expires_at = next_expiry,
      last_heartbeat_at = clock_timestamp()
  where collector_node.node_id = p_node_id;
  update public.bclif_collector_instances as collector_instance
  set fencing_epoch = next_epoch,
      last_heartbeat_at = clock_timestamp()
  where collector_instance.instance_id = p_instance_id
    and collector_instance.node_id = p_node_id;
  return query select next_epoch, next_expiry;
end;
$$;

create or replace function public.bclif_renew_collector_lease(
  p_node_id text,
  p_instance_id text,
  p_fencing_epoch bigint,
  p_lease_ttl_ms integer
)
returns table(lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_expiry timestamptz;
begin
  if p_lease_ttl_ms < 5000 or p_lease_ttl_ms > 300000 then
    raise exception 'BCLIF lease TTL is outside the safe bound' using errcode = '22023';
  end if;
  next_expiry := clock_timestamp() + make_interval(secs => p_lease_ttl_ms::double precision / 1000.0);
  update public.bclif_collector_nodes as collector_node
  set lease_expires_at = next_expiry,
      last_heartbeat_at = clock_timestamp()
  where collector_node.node_id = p_node_id
    and collector_node.current_instance_id = p_instance_id
    and collector_node.fencing_epoch = p_fencing_epoch
    and collector_node.lease_expires_at > clock_timestamp();
  if not found then
    raise exception 'BCLIF collector lease is stale or expired' using errcode = '55000';
  end if;
  update public.bclif_collector_instances as collector_instance
  set last_heartbeat_at = clock_timestamp()
  where collector_instance.instance_id = p_instance_id
    and collector_instance.node_id = p_node_id
    and collector_instance.fencing_epoch = p_fencing_epoch;
  return query select next_expiry;
end;
$$;

revoke all on function public.bclif_acquire_collector_lease(text,text,integer) from public, anon, authenticated;
revoke all on function public.bclif_renew_collector_lease(text,text,bigint,integer) from public, anon, authenticated;
grant execute on function public.bclif_acquire_collector_lease(text,text,integer) to service_role;
grant execute on function public.bclif_renew_collector_lease(text,text,bigint,integer) to service_role;

commit;
