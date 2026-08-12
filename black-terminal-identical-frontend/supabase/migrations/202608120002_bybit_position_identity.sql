begin;

alter table public.exchange_accounts
  add column if not exists position_snapshot_started_at timestamptz;

alter table public.execution_orders
  add column if not exists venue_updated_at bigint not null default 0;

alter table public.account_positions
  add column if not exists network text,
  add column if not exists category text,
  add column if not exists market_kind text,
  add column if not exists position_idx integer,
  add column if not exists canonical_key text;

update public.account_positions
set
  network = coalesce(nullif(lower(network), ''), 'mainnet'),
  category = coalesce(nullif(lower(category), ''), 'linear'),
  market_kind = coalesce(nullif(lower(market_kind), ''), 'perpetual'),
  position_idx = coalesce(position_idx, 0),
  canonical_key = coalesce(
    nullif(canonical_key, ''),
    lower(exchange) || ':' || coalesce(nullif(lower(category), ''), 'linear') || ':' || upper(symbol) || ':' || coalesce(position_idx, 0)::text || ':' || lower(direction)
  );

with duplicates as (
  select id, row_number() over (
    partition by account_id, canonical_key
    order by updated_at desc, id desc
  ) as ordinal
  from public.account_positions
)
delete from public.account_positions target
using duplicates
where target.id = duplicates.id and duplicates.ordinal > 1;

alter table public.account_positions
  alter column network set default 'mainnet',
  alter column network set not null,
  alter column category set default 'linear',
  alter column category set not null,
  alter column market_kind set default 'perpetual',
  alter column market_kind set not null,
  alter column position_idx set default 0,
  alter column position_idx set not null,
  alter column canonical_key set not null;

alter table public.account_positions drop constraint if exists account_positions_position_idx_check;
alter table public.account_positions add constraint account_positions_position_idx_check check (position_idx in (0, 1, 2));
alter table public.account_positions drop constraint if exists account_positions_network_check;
alter table public.account_positions add constraint account_positions_network_check check (network = 'mainnet');

create unique index if not exists idx_account_positions_canonical_identity
  on public.account_positions(account_id, canonical_key);

create or replace function public.replace_bybit_positions_snapshot_v1(
  p_account_id uuid,
  p_snapshot_started_at timestamptz,
  p_rows jsonb
)
returns table(applied boolean, row_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_position_snapshot_started_at timestamptz;
  v_row_count integer := 0;
begin
  select user_id, position_snapshot_started_at
  into v_user_id, v_position_snapshot_started_at
  from public.exchange_accounts
  where id = p_account_id and exchange = 'bybit'
  for update;

  if not found then
    raise exception 'Bybit account not found' using errcode = 'P0002';
  end if;
  if auth.role() <> 'service_role' and auth.uid() is distinct from v_user_id then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  if p_snapshot_started_at is null or p_snapshot_started_at > now() + interval '5 minutes' then
    raise exception 'Invalid broker snapshot timestamp' using errcode = '22023';
  end if;
  if v_position_snapshot_started_at is not null and p_snapshot_started_at < v_position_snapshot_started_at then
    return query select false, 0;
    return;
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'Invalid broker position snapshot' using errcode = '22023';
  end if;

  insert into public.account_positions (
    account_id, exchange, network, category, market_kind, position_idx, canonical_key,
    symbol, direction, quantity, average_price, current_price, unrealized_pnl,
    realized_pnl, margin, leverage, liquidation_price, stop_loss, take_profit,
    opened_at, updated_at
  )
  select
    p_account_id,
    'bybit',
    'mainnet',
    lower(coalesce(nullif(item->>'category', ''), 'linear')),
    lower(coalesce(nullif(item->>'marketKind', ''), 'perpetual')),
    coalesce((item->>'positionIdx')::integer, 0),
    item->>'canonicalKey',
    upper(item->>'symbol'),
    lower(item->>'direction'),
    (item->>'quantity')::numeric,
    nullif(item->>'averagePrice', '')::numeric,
    nullif(item->>'currentPrice', '')::numeric,
    coalesce(nullif(item->>'unrealizedPnl', '')::numeric, 0),
    coalesce(nullif(item->>'realizedPnl', '')::numeric, 0),
    coalesce(nullif(item->>'margin', '')::numeric, 0),
    coalesce(nullif(item->>'leverage', '')::numeric, 1),
    nullif(item->>'liquidationPrice', '')::numeric,
    nullif(item->>'stopLoss', '')::numeric,
    nullif(item->>'takeProfit', '')::numeric,
    coalesce(nullif(item->>'openedAt', '')::timestamptz, p_snapshot_started_at),
    coalesce(nullif(item->>'updatedAt', '')::timestamptz, p_snapshot_started_at)
  from jsonb_array_elements(p_rows) item
  where
    item ? 'canonicalKey'
    and item ? 'symbol'
    and item ? 'direction'
    and nullif(item->>'quantity', '')::numeric > 0
    and coalesce((item->>'positionIdx')::integer, 0) in (0, 1, 2)
  on conflict (account_id, canonical_key) do update set
    category = excluded.category,
    market_kind = excluded.market_kind,
    position_idx = excluded.position_idx,
    symbol = excluded.symbol,
    direction = excluded.direction,
    quantity = excluded.quantity,
    average_price = excluded.average_price,
    current_price = excluded.current_price,
    unrealized_pnl = excluded.unrealized_pnl,
    realized_pnl = excluded.realized_pnl,
    margin = excluded.margin,
    leverage = excluded.leverage,
    liquidation_price = excluded.liquidation_price,
    stop_loss = excluded.stop_loss,
    take_profit = excluded.take_profit,
    opened_at = excluded.opened_at,
    updated_at = excluded.updated_at;

  get diagnostics v_row_count = row_count;
  delete from public.account_positions stored
  where stored.account_id = p_account_id
    and not exists (
      select 1 from jsonb_array_elements(p_rows) item
      where item->>'canonicalKey' = stored.canonical_key
    );

  update public.exchange_accounts
  set
    position_snapshot_started_at = p_snapshot_started_at,
    last_synced_at = greatest(coalesce(last_synced_at, p_snapshot_started_at), p_snapshot_started_at),
    last_sync_error = null
  where id = p_account_id;

  return query select true, v_row_count;
end;
$$;

revoke all on function public.replace_bybit_positions_snapshot_v1(uuid,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.replace_bybit_positions_snapshot_v1(uuid,timestamptz,jsonb) to service_role;
commit;
