# Supabase Migration Ledger

This file records database migrations required by Black Terminal.

Rule: every new table, column, policy, trigger, function, or index must be added here before it is applied in Supabase.

## Existing Database Domains

The current Vercel API routes expect these Supabase domains:

- `exchange_accounts`
- `exchange_credentials`
- `account_risk_controls`
- `account_balances`
- `account_positions`
- `execution_orders`
- `execution_audit_logs`

Those tables were introduced during the Portfolio Manager and execution phases. Future schema changes should be committed here with exact SQL.

## 2026-07-05 - Connectivity Connections

Status: Recommended for Phase III persistent connectivity registry.

Purpose:

- Persist the Black Core Connection Manager account registry.
- Allow Positions, Execution Ticket, Portfolio Statistics, Allocation Engine, and Investment Groups to recover active account metadata after refresh.
- Store capability, health, permission, and metadata snapshots without storing plain-text secrets.

SQL:

```sql
create extension if not exists pgcrypto;

create table if not exists public.connectivity_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_key text not null,
  category text not null check (category in ('centralized-exchange','wallet','market-data','institutional')),
  provider text not null,
  label text not null,
  status text not null default 'connected',
  account_id uuid references public.exchange_accounts(id) on delete set null,
  wallet_address text,
  capabilities jsonb not null default '[]'::jsonb,
  health jsonb not null default '{}'::jsonb,
  permissions jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, connection_key)
);

create index if not exists idx_connectivity_connections_user_status
  on public.connectivity_connections(user_id, status);

create index if not exists idx_connectivity_connections_account
  on public.connectivity_connections(account_id);

alter table public.connectivity_connections enable row level security;

create policy "connectivity_connections_select_own"
  on public.connectivity_connections
  for select
  using (auth.uid() = user_id);

create policy "connectivity_connections_insert_own"
  on public.connectivity_connections
  for insert
  with check (auth.uid() = user_id);

create policy "connectivity_connections_update_own"
  on public.connectivity_connections
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "connectivity_connections_delete_own"
  on public.connectivity_connections
  for delete
  using (auth.uid() = user_id);
```

## 2026-07-05 - Connectivity Audit Events

Status: Recommended for Phase III persistent connectivity audit.

Purpose:

- Persist connection established, removed, reconnect, heartbeat, auth failure, permission, and diagnostic events.
- Keep connectivity audit separate from execution audit.

SQL:

```sql
create table if not exists public.connectivity_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  connection_key text,
  account_id uuid references public.exchange_accounts(id) on delete set null,
  event_type text not null,
  severity text not null default 'info' check (severity in ('info','warning','error')),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_connectivity_audit_user_time
  on public.connectivity_audit_events(user_id, created_at desc);

create index if not exists idx_connectivity_audit_connection_time
  on public.connectivity_audit_events(connection_id, created_at desc);

alter table public.connectivity_audit_events enable row level security;

create policy "connectivity_audit_select_own"
  on public.connectivity_audit_events
  for select
  using (auth.uid() = user_id);

create policy "connectivity_audit_insert_own"
  on public.connectivity_audit_events
  for insert
  with check (auth.uid() = user_id);
```
