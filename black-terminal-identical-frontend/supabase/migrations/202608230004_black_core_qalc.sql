begin;

create table if not exists public.qalc_strategy_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 3 and 80),
  engine_id text not null default 'black-core-qalc' check (engine_id = 'black-core-qalc'),
  venue text not null default 'BYBIT' check (venue = 'BYBIT'),
  symbol text not null default 'BTCUSDT' check (symbol in ('BTCUSDT', 'ETHUSDT')),
  category text not null default 'linear' check (category = 'linear'),
  mode text not null default 'RESEARCH' check (mode in ('RESEARCH', 'PAPER', 'SHADOW')),
  desired_state text not null default 'STOPPED' check (desired_state in ('STOPPED', 'ACTIVE', 'PAUSED')),
  certification_state text not null default 'RESEARCH' check (certification_state in ('RESEARCH', 'EVENT_REPLAY_CERTIFIED', 'PAPER_CANDIDATE', 'PAPER_CERTIFIED', 'SHADOW_CERTIFIED')),
  paper_equity numeric(24,8) not null default 10000 check (paper_equity > 0),
  strategy_allocation_percent numeric(8,5) not null default 10 check (strategy_allocation_percent > 0 and strategy_allocation_percent <= 100),
  config jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.qalc_runs (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.qalc_strategy_configs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('REPLAY', 'PAPER', 'SHADOW')),
  model_version text not null,
  state text not null,
  start_reason text,
  stop_reason text,
  metrics jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.qalc_archive_chunks (
  id uuid primary key default gen_random_uuid(),
  venue text not null check (venue = 'BYBIT'),
  category text not null check (category = 'linear'),
  symbol text not null check (symbol in ('BTCUSDT', 'ETHUSDT')),
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  event_count bigint not null check (event_count >= 0),
  byte_count bigint not null check (byte_count >= 0),
  first_event_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.qalc_audit_events (
  id bigint generated always as identity primary key,
  strategy_id uuid references public.qalc_strategy_configs(id) on delete cascade,
  run_id uuid references public.qalc_runs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  event_type text not null,
  severity text not null check (severity in ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  message text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists qalc_strategy_configs_user_updated_idx on public.qalc_strategy_configs(user_id, updated_at desc);
create index if not exists qalc_runs_strategy_started_idx on public.qalc_runs(strategy_id, started_at desc);
create index if not exists qalc_archive_chunks_symbol_time_idx on public.qalc_archive_chunks(symbol, first_event_at desc);
create index if not exists qalc_audit_events_strategy_created_idx on public.qalc_audit_events(strategy_id, created_at desc);

alter table public.qalc_strategy_configs enable row level security;
alter table public.qalc_runs enable row level security;
alter table public.qalc_archive_chunks enable row level security;
alter table public.qalc_audit_events enable row level security;

drop policy if exists qalc_strategy_configs_owner_select on public.qalc_strategy_configs;
create policy qalc_strategy_configs_owner_select on public.qalc_strategy_configs for select to authenticated using (user_id = auth.uid());
drop policy if exists qalc_strategy_configs_owner_insert on public.qalc_strategy_configs;
create policy qalc_strategy_configs_owner_insert on public.qalc_strategy_configs for insert to authenticated with check (user_id = auth.uid() and (config->>'liveExecutionEnabled')::boolean is false and (config->>'groupFanoutEnabled')::boolean is false);
drop policy if exists qalc_strategy_configs_owner_update on public.qalc_strategy_configs;
create policy qalc_strategy_configs_owner_update on public.qalc_strategy_configs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and (config->>'liveExecutionEnabled')::boolean is false and (config->>'groupFanoutEnabled')::boolean is false);
drop policy if exists qalc_strategy_configs_owner_delete on public.qalc_strategy_configs;
create policy qalc_strategy_configs_owner_delete on public.qalc_strategy_configs for delete to authenticated using (user_id = auth.uid() and desired_state <> 'ACTIVE');

drop policy if exists qalc_runs_owner_select on public.qalc_runs;
create policy qalc_runs_owner_select on public.qalc_runs for select to authenticated using (user_id = auth.uid());
drop policy if exists qalc_audit_owner_select on public.qalc_audit_events;
create policy qalc_audit_owner_select on public.qalc_audit_events for select to authenticated using (user_id = auth.uid());

revoke all on public.qalc_strategy_configs, public.qalc_archive_chunks, public.qalc_runs, public.qalc_audit_events from anon, authenticated;
revoke insert, update, delete on public.qalc_runs from anon, authenticated;
revoke insert, update, delete on public.qalc_audit_events from anon, authenticated;
grant select on public.qalc_strategy_configs, public.qalc_runs, public.qalc_audit_events to authenticated;

commit;
