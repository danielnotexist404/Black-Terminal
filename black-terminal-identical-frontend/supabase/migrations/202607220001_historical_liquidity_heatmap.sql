create table if not exists public.book_heatmap_depth_chunks (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  market_kind text not null,
  symbol text not null,
  chunk_start timestamptz not null,
  chunk_end timestamptz not null,
  resolution_ms integer not null check (resolution_ms in (1000, 5000, 15000, 60000)),
  frame_count integer not null check (frame_count > 0 and frame_count <= 300),
  sequence_start text,
  sequence_end text,
  compression text not null check (compression in ('gzip-json-v1')),
  payload bytea not null,
  compressed_bytes integer not null check (compressed_bytes > 0),
  uncompressed_bytes integer not null check (uncompressed_bytes > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue, market_kind, symbol, chunk_start, resolution_ms)
);

create index if not exists idx_book_heatmap_chunks_lookup
  on public.book_heatmap_depth_chunks (venue, market_kind, symbol, resolution_ms, chunk_start desc);

create table if not exists public.book_heatmap_collector_coverage (
  venue text not null,
  market_kind text not null,
  symbol text not null,
  state text not null check (state in ('STARTING','SNAPSHOT_LOADING','SYNCHRONIZING','LIVE','GAP_DETECTED','RESYNCING','DEGRADED','FAILED')),
  earliest_timestamp timestamptz,
  latest_timestamp timestamptz,
  frame_count bigint not null default 0 check (frame_count >= 0),
  gap_count integer not null default 0 check (gap_count >= 0),
  continuity_percent numeric not null default 0 check (continuity_percent >= 0 and continuity_percent <= 100),
  last_sequence text,
  last_heartbeat_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (venue, market_kind, symbol)
);

alter table public.book_heatmap_depth_chunks enable row level security;
alter table public.book_heatmap_collector_coverage enable row level security;
revoke all on public.book_heatmap_depth_chunks from anon, authenticated;
revoke all on public.book_heatmap_collector_coverage from anon, authenticated;
grant all on public.book_heatmap_depth_chunks to service_role;
grant all on public.book_heatmap_collector_coverage to service_role;
