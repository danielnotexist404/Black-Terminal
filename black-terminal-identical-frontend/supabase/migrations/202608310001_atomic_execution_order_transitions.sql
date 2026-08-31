-- Serialize Black Cloud order state from REST acknowledgements and Bybit's
-- private stream. The database owns cumulative-fill and lifecycle precedence;
-- callers cannot race a terminal/fill state back to an earlier snapshot.
begin;

-- Keep the last cumulative order-report clock separate from incremental fill
-- clocks. This prevents an order event and its matching execution event from
-- counting the same venue fill twice regardless of WebSocket arrival order.
alter table public.execution_orders
  add column if not exists venue_cumulative_updated_at bigint;

create or replace function public.black_cloud_apply_execution_order_state_v1(
  p_order_id uuid,
  p_account_id uuid,
  p_reported_status text default null,
  p_cumulative_filled_quantity numeric default null,
  p_fill_delta numeric default null,
  p_exchange_order_id text default null,
  p_average_fill_price numeric default null,
  p_actual_fee_delta numeric default null,
  p_rejection_reason text default null,
  p_venue_updated_at bigint default 0,
  p_follower_plan_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.execution_orders%rowtype;
  v_plan public.follower_execution_plans%rowtype;
  v_current_status text;
  v_reported_status text;
  v_next_status text;
  v_current_rank integer;
  v_reported_rank integer;
  v_current_filled numeric;
  v_next_filled numeric;
  v_next_plan_status text;
  v_metadata_is_current boolean;
  v_fill_already_cumulative boolean := false;
  v_cumulative_clock bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'execution service identity required' using errcode = '42501';
  end if;
  if p_order_id is null or p_account_id is null then
    raise exception 'execution order and account are required' using errcode = '22023';
  end if;
  if p_cumulative_filled_quantity is not null and p_fill_delta is not null then
    raise exception 'provide cumulative fill or fill delta, not both' using errcode = '22023';
  end if;
  if p_cumulative_filled_quantity is not null and (
    p_cumulative_filled_quantity < 0 or lower(p_cumulative_filled_quantity::text) in ('nan', 'infinity', '-infinity')
  ) then
    raise exception 'invalid cumulative fill quantity' using errcode = '22023';
  end if;
  if p_fill_delta is not null and (
    p_fill_delta < 0 or lower(p_fill_delta::text) in ('nan', 'infinity', '-infinity')
  ) then
    raise exception 'invalid fill delta' using errcode = '22023';
  end if;
  if p_average_fill_price is not null and (
    p_average_fill_price <= 0 or lower(p_average_fill_price::text) in ('nan', 'infinity', '-infinity')
  ) then
    raise exception 'invalid average fill price' using errcode = '22023';
  end if;
  if p_actual_fee_delta is not null and lower(p_actual_fee_delta::text) in ('nan', 'infinity', '-infinity') then
    raise exception 'invalid fee delta' using errcode = '22023';
  end if;
  if coalesce(p_venue_updated_at, 0) < 0 then
    raise exception 'invalid venue update clock' using errcode = '22023';
  end if;

  select order_row.*
  into v_order
  from public.execution_orders order_row
  where order_row.id = p_order_id
    and order_row.account_id = p_account_id
  for update;

  if not found then
    raise exception 'execution order ownership mismatch' using errcode = '42501';
  end if;

  v_current_status := case replace(lower(trim(coalesce(v_order.status, 'accepted'))), '_', '-')
    when 'filled' then 'filled'
    when 'partially-filled' then 'partially-filled'
    when 'partiallyfilled' then 'partially-filled'
    when 'cancelled' then 'cancelled'
    when 'canceled' then 'cancelled'
    when 'expired' then 'cancelled'
    when 'deactivated' then 'cancelled'
    when 'rejected' then 'rejected'
    when 'failed' then 'rejected'
    else 'accepted'
  end;

  if p_reported_status is null or trim(p_reported_status) = '' then
    v_reported_status := v_current_status;
  else
    v_reported_status := case replace(lower(trim(p_reported_status)), '_', '-')
      when 'filled' then 'filled'
      when 'partially-filled' then 'partially-filled'
      when 'partiallyfilled' then 'partially-filled'
      when 'cancelled' then 'cancelled'
      when 'canceled' then 'cancelled'
      when 'expired' then 'cancelled'
      when 'deactivated' then 'cancelled'
      when 'rejected' then 'rejected'
      when 'failed' then 'rejected'
      when 'accepted' then 'accepted'
      when 'created' then 'accepted'
      when 'new' then 'accepted'
      when 'pending' then 'accepted'
      when 'open' then 'accepted'
      when 'working' then 'accepted'
      when 'untriggered' then 'accepted'
      else null
    end;
    if v_reported_status is null then
      raise exception 'unsupported execution order status' using errcode = '22023';
    end if;
  end if;

  v_current_filled := greatest(coalesce(v_order.filled_quantity, 0), 0);
  v_cumulative_clock := greatest(coalesce(v_order.venue_cumulative_updated_at, v_order.venue_updated_at, 0), 0);
  if p_fill_delta is not null then
    -- The row lock makes concurrent private fill increments atomic. Durable
    -- inbox identities make each venue fill event enter this branch once. A
    -- cumulative order report at or after the execution clock already owns
    -- this quantity, so the incremental event must not add it again.
    v_fill_already_cumulative := coalesce(p_venue_updated_at, 0) > 0
      and v_cumulative_clock > 0
      and p_venue_updated_at <= v_cumulative_clock;
    v_next_filled := case when v_fill_already_cumulative
      then v_current_filled
      else v_current_filled + p_fill_delta
    end;
  else
    v_next_filled := greatest(v_current_filled, coalesce(p_cumulative_filled_quantity, 0));
  end if;

  v_current_rank := case v_current_status
    when 'accepted' then 1
    when 'partially-filled' then 2
    when 'cancelled' then 3
    when 'rejected' then 3
    when 'filled' then 4
    else 0
  end;
  v_reported_rank := case v_reported_status
    when 'accepted' then 1
    when 'partially-filled' then 2
    when 'cancelled' then 3
    when 'rejected' then 3
    when 'filled' then 4
    else 0
  end;
  v_next_status := case
    when v_current_rank >= v_reported_rank then v_current_status
    else v_reported_status
  end;
  if coalesce(v_order.quantity, 0) > 0 and v_next_filled + 0.000000000001 >= v_order.quantity then
    v_next_status := 'filled';
  elsif v_next_filled > 0 and v_next_status = 'accepted' then
    v_next_status := 'partially-filled';
  end if;

  v_metadata_is_current := coalesce(p_venue_updated_at, 0) = 0
    or coalesce(v_order.venue_updated_at, 0) = 0
    or p_venue_updated_at >= coalesce(v_order.venue_updated_at, 0);

  update public.execution_orders order_row
  set
    status = v_next_status,
    filled_quantity = v_next_filled,
    exchange_order_id = case
      when nullif(p_exchange_order_id, '') is null then order_row.exchange_order_id
      when order_row.exchange_order_id is null or v_metadata_is_current then p_exchange_order_id
      else order_row.exchange_order_id
    end,
    average_fill_price = case
      when p_average_fill_price is null then order_row.average_fill_price
      when p_fill_delta is not null and v_fill_already_cumulative then order_row.average_fill_price
      when p_fill_delta is not null and p_fill_delta > 0 and v_current_filled > 0 and order_row.average_fill_price is not null
        then ((v_current_filled * order_row.average_fill_price) + (p_fill_delta * p_average_fill_price)) / (v_current_filled + p_fill_delta)
      when order_row.average_fill_price is null or v_metadata_is_current then p_average_fill_price
      else order_row.average_fill_price
    end,
    actual_fees = coalesce(order_row.actual_fees, 0) + coalesce(p_actual_fee_delta, 0),
    rejection_reason = case
      when p_rejection_reason is null then order_row.rejection_reason
      when v_metadata_is_current then left(p_rejection_reason, 1000)
      else order_row.rejection_reason
    end,
    venue_updated_at = greatest(coalesce(order_row.venue_updated_at, 0), coalesce(p_venue_updated_at, 0)),
    venue_cumulative_updated_at = case
      when p_cumulative_filled_quantity is not null
      then greatest(v_cumulative_clock, coalesce(p_venue_updated_at, 0))
      else v_cumulative_clock
    end,
    updated_at = timezone('utc', now())
  where order_row.id = v_order.id;

  if p_follower_plan_id is not null then
    select plan_row.*
    into v_plan
    from public.follower_execution_plans plan_row
    join public.connectivity_connections connection_row
      on connection_row.id = plan_row.broker_connection_id
    where plan_row.id = p_follower_plan_id
      and plan_row.follower_user_id = v_order.user_id
      and connection_row.account_id = v_order.account_id
    for update of plan_row;

    if not found or (v_plan.execution_order_id is not null and v_plan.execution_order_id <> v_order.id) then
      raise exception 'follower execution plan ownership mismatch' using errcode = '42501';
    end if;

    update public.follower_execution_plans
    set execution_order_id = v_order.id, updated_at = now()
    where id = v_plan.id;
  end if;

  v_next_plan_status := case
    when v_next_status = 'filled' then 'FILLED'
    when v_next_filled > 0 then 'PARTIALLY_FILLED'
    when v_next_status = 'cancelled' then 'CANCELLED'
    when v_next_status = 'rejected' then 'VENUE_REJECTED'
    else 'WORKING'
  end;

  -- A fill may arrive after a terminal zero-fill order report. Real fills
  -- therefore outrank rejection/cancellation, while FILLED is irreversible.
  update public.follower_execution_plans plan_row
  set
    execution_status = case
      when plan_row.execution_status = 'FILLED' then 'FILLED'
      when v_next_plan_status = 'FILLED' then 'FILLED'
      when v_next_plan_status = 'PARTIALLY_FILLED' then 'PARTIALLY_FILLED'
      when plan_row.execution_status = 'PARTIALLY_FILLED' then 'PARTIALLY_FILLED'
      when plan_row.execution_status in (
        'RISK_REJECTED', 'CONNECTION_UNHEALTHY', 'AUTH_EXPIRED', 'INSUFFICIENT_MARGIN',
        'SYMBOL_NOT_ALLOWED', 'MANDATE_PAUSED', 'VENUE_REJECTED', 'RECONCILIATION_REQUIRED', 'CANCELLED'
      ) then plan_row.execution_status
      when v_next_plan_status in ('VENUE_REJECTED', 'CANCELLED') then v_next_plan_status
      when plan_row.execution_status in ('EXECUTED', 'WORKING') then plan_row.execution_status
      else 'WORKING'
    end,
    updated_at = now()
  where plan_row.execution_order_id = v_order.id
    and plan_row.follower_user_id = v_order.user_id;

  return jsonb_build_object(
    'orderId', v_order.id,
    'accountId', v_order.account_id,
    'status', v_next_status,
    'filledQuantity', v_next_filled,
    'venueUpdatedAt', greatest(coalesce(v_order.venue_updated_at, 0), coalesce(p_venue_updated_at, 0)),
    'followerPlanStatus', v_next_plan_status
  );
end;
$$;

revoke all on function public.black_cloud_apply_execution_order_state_v1(uuid,uuid,text,numeric,numeric,text,numeric,numeric,text,bigint,uuid)
  from public, anon, authenticated;
grant execute on function public.black_cloud_apply_execution_order_state_v1(uuid,uuid,text,numeric,numeric,text,numeric,numeric,text,bigint,uuid)
  to service_role;

commit;
