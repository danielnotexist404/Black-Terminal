begin;

create table if not exists public.broker_account_equity_snapshots (
  account_id uuid primary key references public.exchange_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  execution_environment text not null check (execution_environment in ('DEMO', 'MAINNET_LIVE')),
  account_type text not null default 'UNIFIED',
  wallet_balance_usd numeric(38,18) not null,
  equity_usd numeric(38,18) not null,
  margin_balance_usd numeric(38,18) not null,
  available_balance_usd numeric(38,18) not null,
  initial_margin_usd numeric(38,18) not null,
  maintenance_margin_usd numeric(38,18) not null,
  unrealized_pnl_usd numeric(38,18) not null,
  account_im_rate numeric(38,18),
  account_mm_rate numeric(38,18),
  observed_at timestamptz not null,
  captured_at timestamptz not null default now(),
  check (available_balance_usd >= 0),
  check (initial_margin_usd >= 0),
  check (maintenance_margin_usd >= 0)
);

create index if not exists idx_broker_account_equity_snapshots_owner
  on public.broker_account_equity_snapshots(user_id, observed_at desc);

alter table public.broker_account_equity_snapshots enable row level security;

drop policy if exists broker_account_equity_snapshots_select_own on public.broker_account_equity_snapshots;
create policy broker_account_equity_snapshots_select_own
  on public.broker_account_equity_snapshots
  for select
  using (auth.uid() = user_id);

revoke all on table public.broker_account_equity_snapshots from public, anon, authenticated;
grant select on table public.broker_account_equity_snapshots to authenticated;
grant all on table public.broker_account_equity_snapshots to service_role;

commit;
