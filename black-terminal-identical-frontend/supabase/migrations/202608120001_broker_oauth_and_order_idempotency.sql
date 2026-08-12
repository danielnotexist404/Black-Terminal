begin;

create table if not exists public.broker_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  state_hash text not null unique,
  account_name text not null,
  execution_environment text not null,
  endpoint_profile text not null default 'GLOBAL',
  return_path text not null default '/',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint broker_oauth_states_provider_check check (provider in ('bybit')),
  constraint broker_oauth_states_return_path_check check (return_path like '/%' and return_path not like '//%')
);

alter table public.broker_oauth_states enable row level security;
revoke all on public.broker_oauth_states from anon, authenticated;
create index if not exists idx_broker_oauth_states_user_expiry on public.broker_oauth_states(user_id, expires_at desc);

alter table public.execution_orders
  add column if not exists client_order_id text,
  add column if not exists exchange_order_id text;

create unique index if not exists idx_execution_orders_user_account_client_idempotency
  on public.execution_orders(user_id, account_id, client_order_id)
  where client_order_id is not null and client_order_id <> '';

commit;
