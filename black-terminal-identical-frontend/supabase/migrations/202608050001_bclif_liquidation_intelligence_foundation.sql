begin;

-- Metadata and compact canonical events only. Dense field cells belong in
-- chunked object storage; never create one database row per pixel/cell.
create table if not exists public.bclif_sources (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  symbol text not null,
  market_kind text not null default 'linear_perpetual',
  source_version text not null,
  collector_node text,
  state text not null check (state in ('STARTING','COLLECTING','LIVE','STALE','DEGRADED','FAILED','DISABLED')),
  last_heartbeat_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue, symbol, market_kind, source_version)
);

create table if not exists public.bclif_coverage (
  source_id uuid primary key references public.bclif_sources(id) on delete cascade,
  requested_start timestamptz,
  requested_end timestamptz,
  available_start timestamptz,
  available_end timestamptz,
  trade_coverage_percent numeric not null default 0 check (trade_coverage_percent between 0 and 100),
  open_interest_coverage_percent numeric not null default 0 check (open_interest_coverage_percent between 0 and 100),
  liquidation_coverage_percent numeric not null default 0 check (liquidation_coverage_percent between 0 and 100),
  orderbook_coverage_percent numeric not null default 0 check (orderbook_coverage_percent between 0 and 100),
  model_continuity_percent numeric not null default 0 check (model_continuity_percent between 0 and 100),
  missing_intervals jsonb not null default '[]'::jsonb,
  quality text not null check (quality in ('EXCELLENT','HIGH','MIXED','LOW','INSUFFICIENT')),
  updated_at timestamptz not null default now()
);

create table if not exists public.bclif_confirmed_liquidation_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  venue_event_id text not null,
  event_time timestamptz not null,
  received_at timestamptz not null,
  liquidated_position_side text not null check (liquidated_position_side in ('LONG','SHORT')),
  quantity numeric not null check (quantity > 0),
  bankruptcy_price numeric not null check (bankruptcy_price > 0),
  notional numeric not null check (notional > 0),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, venue_event_id)
);

create index if not exists idx_bclif_events_lookup
  on public.bclif_confirmed_liquidation_events (source_id, event_time desc);

create table if not exists public.bclif_field_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  model_version text not null,
  horizon text not null,
  chunk_start timestamptz not null,
  chunk_end timestamptz not null,
  columns integer not null check (columns between 1 and 4096),
  rows integer not null check (rows between 1 and 4096),
  price_min numeric not null,
  price_max numeric not null,
  compression text not null,
  object_path text not null,
  checksum text not null,
  compressed_bytes bigint check (compressed_bytes is null or compressed_bytes > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, model_version, horizon, chunk_start, columns, rows)
);

create index if not exists idx_bclif_chunks_lookup
  on public.bclif_field_chunks (source_id, horizon, chunk_start desc);

create table if not exists public.bclif_model_evaluations (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bclif_sources(id) on delete cascade,
  model_version text not null,
  evaluation_start timestamptz not null,
  evaluation_end timestamptz not null,
  calibration_error numeric,
  event_hit_rate numeric,
  false_positive_rate numeric,
  visual_regression_score numeric,
  performance jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.bclif_sources enable row level security;
alter table public.bclif_coverage enable row level security;
alter table public.bclif_confirmed_liquidation_events enable row level security;
alter table public.bclif_field_chunks enable row level security;
alter table public.bclif_model_evaluations enable row level security;

revoke all on public.bclif_sources from anon, authenticated;
revoke all on public.bclif_coverage from anon, authenticated;
revoke all on public.bclif_confirmed_liquidation_events from anon, authenticated;
revoke all on public.bclif_field_chunks from anon, authenticated;
revoke all on public.bclif_model_evaluations from anon, authenticated;
grant all on public.bclif_sources to service_role;
grant all on public.bclif_coverage to service_role;
grant all on public.bclif_confirmed_liquidation_events to service_role;
grant all on public.bclif_field_chunks to service_role;
grant all on public.bclif_model_evaluations to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bclif-field-chunks', 'bclif-field-chunks', false, 52428800, array['application/octet-stream'])
on conflict (id) do update set public = false;

commit;
