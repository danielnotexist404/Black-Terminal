begin;

-- Immutable, server-only one-minute aggregates derived from checksum-verified
-- BCLIF TRADE chunks.  Rows retain their source chunk identity so retries are
-- idempotent and no raw or synthetic browser estimate can enter BC-ACVD.
create table if not exists public.bclif_trade_flow_chunk_bars (
  chunk_id uuid not null references public.bclif_canonical_event_chunks(id) on delete cascade,
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  interval_seconds integer not null default 60 check (interval_seconds = 60),
  interval_start timestamptz not null,
  buy_volume numeric not null default 0 check (buy_volume >= 0),
  sell_volume numeric not null default 0 check (sell_volume >= 0),
  unknown_volume numeric not null default 0 check (unknown_volume >= 0),
  buy_notional numeric not null default 0 check (buy_notional >= 0),
  sell_notional numeric not null default 0 check (sell_notional >= 0),
  unknown_notional numeric not null default 0 check (unknown_notional >= 0),
  exact_trade_count bigint not null default 0 check (exact_trade_count >= 0),
  total_trade_count bigint not null check (total_trade_count > 0),
  created_at timestamptz not null default now(),
  primary key (chunk_id, interval_seconds, interval_start)
);

create index if not exists idx_bclif_trade_flow_bars_source_time
  on public.bclif_trade_flow_chunk_bars(source_id, interval_start);

drop trigger if exists trg_bclif_trade_flow_chunk_bars_immutable on public.bclif_trade_flow_chunk_bars;
create trigger trg_bclif_trade_flow_chunk_bars_immutable
before update or delete on public.bclif_trade_flow_chunk_bars
for each row execute function public.bclif_reject_immutable_change();

alter table public.bclif_trade_flow_chunk_bars enable row level security;
revoke all on public.bclif_trade_flow_chunk_bars from public, anon, authenticated;
grant select, insert on public.bclif_trade_flow_chunk_bars to service_role;

comment on table public.bclif_trade_flow_chunk_bars is
  'Immutable exact aggressor-flow cache derived only from verified BCLIF TRADE archives.';

commit;
