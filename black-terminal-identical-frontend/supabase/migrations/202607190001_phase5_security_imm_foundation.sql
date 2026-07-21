begin;
create table if not exists public.market_depth_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  exchange text not null,
  market_kind text not null,
  symbol text not null,
  side text not null check (side in ('bid', 'ask')),
  price_bucket numeric not null,
  bucket_size numeric not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  observations integer not null default 1 check (observations >= 0),
  peak_size numeric not null default 0,
  last_size numeric not null default 0,
  strength numeric not null default 0 check (strength >= 0 and strength <= 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, exchange, market_kind, symbol, side, price_bucket)
);

create index if not exists idx_market_depth_memory_user_symbol_time
  on public.market_depth_memory(user_id, exchange, market_kind, symbol, last_seen_at desc);

create index if not exists idx_market_depth_memory_user_symbol_side_price
  on public.market_depth_memory(user_id, exchange, market_kind, symbol, side, price_bucket);

create or replace function public.set_market_depth_memory_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_market_depth_memory_updated_at on public.market_depth_memory;
create trigger trg_market_depth_memory_updated_at
before update on public.market_depth_memory
for each row
execute function public.set_market_depth_memory_updated_at();

alter table public.market_depth_memory enable row level security;

create policy "market_depth_memory_select_own"
  on public.market_depth_memory for select
  using (auth.uid() = user_id);

create policy "market_depth_memory_insert_own"
  on public.market_depth_memory for insert
  with check (auth.uid() = user_id);

create policy "market_depth_memory_update_own"
  on public.market_depth_memory for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "market_depth_memory_delete_own"
  on public.market_depth_memory for delete
  using (auth.uid() = user_id);

create extension if not exists pgcrypto;

create table if not exists public.market_depth_snapshots (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  market_kind text not null,
  symbol text not null,
  exchange_symbol text not null,
  captured_at timestamptz not null,
  source_timestamp timestamptz,
  sequence text,
  best_bid numeric,
  best_ask numeric,
  mid_price numeric,
  spread numeric,
  depth_levels jsonb not null default '{}'::jsonb,
  checksum text,
  compression_version integer not null default 1,
  retention_tier text not null default 'raw-hours',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_market_depth_snapshots_symbol_time
  on public.market_depth_snapshots(venue, market_kind, symbol, captured_at desc);

create table if not exists public.market_depth_deltas (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  market_kind text not null,
  symbol text not null,
  captured_at timestamptz not null,
  side text not null check (side in ('bid', 'ask')),
  price numeric not null,
  quantity numeric not null default 0,
  delta_size numeric not null default 0,
  action text not null check (action in ('add', 'update', 'remove')),
  sequence text,
  resolution text not null default 'raw',
  compression_version integer not null default 1,
  retention_tier text not null default 'raw-hours',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_market_depth_deltas_symbol_time
  on public.market_depth_deltas(venue, market_kind, symbol, captured_at desc);

create index if not exists idx_market_depth_deltas_symbol_price
  on public.market_depth_deltas(venue, market_kind, symbol, side, price);

create table if not exists public.market_depth_rollups (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  market_kind text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  resolution text not null check (resolution in ('1s', '10s', '1m')),
  price_bucket numeric not null,
  bucket_size numeric not null,
  bid_size numeric not null default 0,
  ask_size numeric not null default 0,
  bid_peak_size numeric not null default 0,
  ask_peak_size numeric not null default 0,
  observations integer not null default 0 check (observations >= 0),
  liquidity_score numeric not null default 0 check (liquidity_score >= 0 and liquidity_score <= 1),
  gravity_score numeric not null default 0 check (gravity_score >= 0 and gravity_score <= 1),
  compression_version integer not null default 1,
  retention_tier text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue, market_kind, symbol, resolution, bucket_start, price_bucket)
);

create index if not exists idx_market_depth_rollups_symbol_time
  on public.market_depth_rollups(venue, market_kind, symbol, resolution, bucket_start desc);

create index if not exists idx_market_depth_rollups_symbol_price
  on public.market_depth_rollups(venue, market_kind, symbol, resolution, price_bucket);

create table if not exists public.market_liquidity_walls (
  id uuid primary key default gen_random_uuid(),
  wall_key text not null unique,
  venue text not null,
  market_kind text not null,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  status text not null check (status in ('ACTIVE', 'GROWING', 'WEAKENING', 'MIGRATING', 'PULLED', 'ABSORBED', 'BROKEN', 'SPOOF_SUSPECTED')),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  current_price numeric not null,
  peak_size numeric not null default 0,
  current_size numeric not null default 0,
  touches integer not null default 0 check (touches >= 0),
  executed_volume numeric not null default 0,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  spoof_probability numeric not null default 0 check (spoof_probability >= 0 and spoof_probability <= 1),
  reliability_score numeric not null default 0 check (reliability_score >= 0 and reliability_score <= 1),
  gravity_score numeric not null default 0 check (gravity_score >= 0 and gravity_score <= 1),
  compression_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_market_liquidity_walls_symbol_status
  on public.market_liquidity_walls(venue, market_kind, symbol, status, last_seen_at desc);

create index if not exists idx_market_liquidity_walls_symbol_price
  on public.market_liquidity_walls(venue, market_kind, symbol, side, current_price);

create table if not exists public.market_liquidity_events (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  market_kind text not null,
  symbol text not null,
  event_type text not null check (event_type in (
    'WALL_APPEARED',
    'WALL_STRENGTHENED',
    'WALL_WEAKENED',
    'WALL_MIGRATED',
    'WALL_PULLED',
    'WALL_ABSORBED',
    'LIQUIDITY_VACUUM',
    'POC_MIGRATED',
    'ICEBERG_DETECTED',
    'STACKING_DETECTED',
    'PULLING_DETECTED'
  )),
  side text check (side in ('buy', 'sell')),
  price numeric,
  price_bucket numeric,
  size numeric,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  wall_key text,
  occurred_at timestamptz not null,
  resolution text not null default '1s',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_market_liquidity_events_symbol_time
  on public.market_liquidity_events(venue, market_kind, symbol, occurred_at desc);

create index if not exists idx_market_liquidity_events_symbol_type
  on public.market_liquidity_events(venue, market_kind, symbol, event_type, occurred_at desc);

create table if not exists public.market_depth_statistics (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  market_kind text not null,
  symbol text not null,
  resolution text not null check (resolution in ('1s', '10s', '1m')),
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  best_bid numeric,
  best_ask numeric,
  mid_price numeric,
  spread numeric,
  total_bid_size numeric not null default 0,
  total_ask_size numeric not null default 0,
  imbalance numeric not null default 0,
  liquidity_score numeric not null default 0 check (liquidity_score >= 0 and liquidity_score <= 1),
  update_count integer not null default 0 check (update_count >= 0),
  packet_loss_count integer not null default 0 check (packet_loss_count >= 0),
  reconnect_count integer not null default 0 check (reconnect_count >= 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue, market_kind, symbol, resolution, bucket_start)
);

create index if not exists idx_market_depth_statistics_symbol_time
  on public.market_depth_statistics(venue, market_kind, symbol, resolution, bucket_start desc);

create or replace function public.set_market_memory_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_market_depth_rollups_updated_at on public.market_depth_rollups;
create trigger trg_market_depth_rollups_updated_at
before update on public.market_depth_rollups
for each row
execute function public.set_market_memory_updated_at();

drop trigger if exists trg_market_liquidity_walls_updated_at on public.market_liquidity_walls;
create trigger trg_market_liquidity_walls_updated_at
before update on public.market_liquidity_walls
for each row
execute function public.set_market_memory_updated_at();

drop trigger if exists trg_market_depth_statistics_updated_at on public.market_depth_statistics;
create trigger trg_market_depth_statistics_updated_at
before update on public.market_depth_statistics
for each row
execute function public.set_market_memory_updated_at();

alter table public.market_depth_snapshots enable row level security;
alter table public.market_depth_deltas enable row level security;
alter table public.market_depth_rollups enable row level security;
alter table public.market_liquidity_walls enable row level security;
alter table public.market_liquidity_events enable row level security;
alter table public.market_depth_statistics enable row level security;

create table if not exists public.market_depth_collector_status (
  collector_id text primary key,
  status text not null default 'unknown' check (status in ('online', 'degraded', 'offline', 'stale', 'unknown')),
  symbols jsonb not null default '[]'::jsonb,
  diagnostics jsonb not null default '[]'::jsonb,
  last_heartbeat_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_market_depth_collector_status_heartbeat
  on public.market_depth_collector_status(last_heartbeat_at desc);

drop trigger if exists trg_market_depth_collector_status_updated_at on public.market_depth_collector_status;
create trigger trg_market_depth_collector_status_updated_at
before update on public.market_depth_collector_status
for each row
execute function public.set_market_memory_updated_at();

alter table public.market_depth_collector_status enable row level security;

commit;
