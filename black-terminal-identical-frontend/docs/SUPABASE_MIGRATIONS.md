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

## 2026-07-05 - Connectivity Protocol Category

Status: Required before persisting protocol connections such as Hyperliquid.

Purpose:

- Allow `protocol` as a connection category in `connectivity_connections`.
- Keep wallet signer connections separate from protocol execution connections.

SQL:

```sql
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'connectivity_connections_category_check'
      and conrelid = 'public.connectivity_connections'::regclass
  ) then
    alter table public.connectivity_connections
      drop constraint connectivity_connections_category_check;
  end if;
end $$;

alter table public.connectivity_connections
  add constraint connectivity_connections_category_check
  check (category in ('centralized-exchange','wallet','protocol','market-data','institutional'));
```

## 2026-07-05 - Position Lifecycle Tables

Status: Recommended for Phase III Chapter IV persistence.

Purpose:

- Persist managed positions after filled execution.
- Persist protection relationships owned by Position Manager.
- Persist timeline events for trade journal, replay, analytics, and future AI modules.
- Persist notes and tags without mixing them into order history.

SQL:

```sql
create table if not exists public.position_lifecycle_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.exchange_accounts(id) on delete set null,
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  exchange text not null,
  symbol text not null,
  direction text not null check (direction in ('long','short')),
  lifecycle_state text not null default 'open'
    check (lifecycle_state in ('opening','open','protected','scaling','closing','closed','archived')),
  quantity numeric not null default 0,
  average_price numeric not null default 0,
  current_price numeric not null default 0,
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  margin numeric not null default 0,
  leverage numeric not null default 1,
  liquidation_price numeric,
  health jsonb not null default '{}'::jsonb,
  notes text[] not null default '{}'::text[],
  tags text[] not null default '{}'::text[],
  source_order_ids text[] not null default '{}'::text[],
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_position_lifecycle_user_state
  on public.position_lifecycle_positions(user_id, lifecycle_state);

create index if not exists idx_position_lifecycle_account_symbol
  on public.position_lifecycle_positions(account_id, symbol);

alter table public.position_lifecycle_positions enable row level security;

create policy "position_lifecycle_positions_select_own"
  on public.position_lifecycle_positions for select
  using (auth.uid() = user_id);

create policy "position_lifecycle_positions_insert_own"
  on public.position_lifecycle_positions for insert
  with check (auth.uid() = user_id);

create policy "position_lifecycle_positions_update_own"
  on public.position_lifecycle_positions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "position_lifecycle_positions_delete_own"
  on public.position_lifecycle_positions for delete
  using (auth.uid() = user_id);

create table if not exists public.position_protection_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid not null references public.position_lifecycle_positions(id) on delete cascade,
  type text not null check (type in ('take-profit','stop-loss','trailing-stop','break-even','oco')),
  status text not null default 'active'
    check (status in ('pending','active','modifying','cancelled','triggered','failed')),
  price numeric,
  trail_by numeric,
  trail_mode text check (trail_mode in ('percentage','usd','ticks','atr')),
  activation text check (activation in ('immediate','custom-price','offset')),
  activation_price numeric,
  exchange_order_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_position_protection_position
  on public.position_protection_orders(position_id, status);

alter table public.position_protection_orders enable row level security;

create policy "position_protection_select_own"
  on public.position_protection_orders for select
  using (auth.uid() = user_id);

create policy "position_protection_insert_own"
  on public.position_protection_orders for insert
  with check (auth.uid() = user_id);

create policy "position_protection_update_own"
  on public.position_protection_orders for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "position_protection_delete_own"
  on public.position_protection_orders for delete
  using (auth.uid() = user_id);

create table if not exists public.position_timeline_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid not null references public.position_lifecycle_positions(id) on delete cascade,
  event_type text not null,
  message text not null,
  price numeric,
  quantity numeric,
  order_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_position_timeline_position_time
  on public.position_timeline_events(position_id, created_at desc);

alter table public.position_timeline_events enable row level security;

create policy "position_timeline_select_own"
  on public.position_timeline_events for select
  using (auth.uid() = user_id);

create policy "position_timeline_insert_own"
  on public.position_timeline_events for insert
  with check (auth.uid() = user_id);
```

## 2026-07-09 - Hyperliquid Server-Side Execution Relay

Status: Required for Phase III Chapter V.

Purpose:

- Store encrypted Hyperliquid agent/API wallet credentials.
- Keep agent wallet nonces atomic per signer and network.
- Persist relay audit events.
- Persist account sync snapshots for reconciliation.
- Surface execution readiness through `connectivity_connections.metadata`.

SQL:

```sql
create extension if not exists pgcrypto;

create table if not exists public.hyperliquid_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.exchange_accounts(id) on delete cascade,
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  master_wallet_address text not null,
  agent_wallet_address text not null,
  encrypted_agent_private_key text not null,
  network text not null check (network in ('mainnet','testnet')),
  status text not null default 'pending_authorization'
    check (status in ('active','pending_authorization','rotated','revoked','failed')),
  readiness_reason text,
  vault_address text,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists idx_hyperliquid_credentials_user_status
  on public.hyperliquid_credentials(user_id, status);

create index if not exists idx_hyperliquid_credentials_account
  on public.hyperliquid_credentials(account_id);

create index if not exists idx_hyperliquid_credentials_connection
  on public.hyperliquid_credentials(connection_id);

create index if not exists idx_hyperliquid_credentials_agent
  on public.hyperliquid_credentials(agent_wallet_address, network);

alter table public.hyperliquid_credentials enable row level security;

create policy "hyperliquid_credentials_select_own"
  on public.hyperliquid_credentials for select
  using (auth.uid() = user_id);

create policy "hyperliquid_credentials_insert_own"
  on public.hyperliquid_credentials for insert
  with check (auth.uid() = user_id);

create policy "hyperliquid_credentials_update_own"
  on public.hyperliquid_credentials for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "hyperliquid_credentials_delete_own"
  on public.hyperliquid_credentials for delete
  using (auth.uid() = user_id);

create table if not exists public.hyperliquid_nonce_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  credential_id uuid not null references public.hyperliquid_credentials(id) on delete cascade,
  agent_wallet_address text not null,
  network text not null check (network in ('mainnet','testnet')),
  last_nonce bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique(agent_wallet_address, network)
);

create index if not exists idx_hyperliquid_nonce_user
  on public.hyperliquid_nonce_state(user_id);

create index if not exists idx_hyperliquid_nonce_credential
  on public.hyperliquid_nonce_state(credential_id);

alter table public.hyperliquid_nonce_state enable row level security;

create policy "hyperliquid_nonce_select_own"
  on public.hyperliquid_nonce_state for select
  using (auth.uid() = user_id);

create policy "hyperliquid_nonce_insert_own"
  on public.hyperliquid_nonce_state for insert
  with check (auth.uid() = user_id);

create policy "hyperliquid_nonce_update_own"
  on public.hyperliquid_nonce_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.next_hyperliquid_nonce(
  p_user_id uuid,
  p_credential_id uuid,
  p_agent_wallet_address text,
  p_network text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_next bigint;
begin
  if p_network not in ('mainnet','testnet') then
    raise exception 'invalid hyperliquid network';
  end if;

  insert into public.hyperliquid_nonce_state (
    user_id,
    credential_id,
    agent_wallet_address,
    network,
    last_nonce,
    updated_at
  )
  values (
    p_user_id,
    p_credential_id,
    lower(p_agent_wallet_address),
    p_network,
    v_now,
    now()
  )
  on conflict (agent_wallet_address, network)
  do update set
    user_id = excluded.user_id,
    credential_id = excluded.credential_id,
    last_nonce = greatest(public.hyperliquid_nonce_state.last_nonce + 1, floor(extract(epoch from clock_timestamp()) * 1000)::bigint),
    updated_at = now()
  returning last_nonce into v_next;

  return v_next;
end;
$$;

grant execute on function public.next_hyperliquid_nonce(uuid, uuid, text, text) to authenticated;
grant execute on function public.next_hyperliquid_nonce(uuid, uuid, text, text) to service_role;

create table if not exists public.hyperliquid_order_relay_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.exchange_accounts(id) on delete set null,
  connection_id uuid references public.connectivity_connections(id) on delete set null,
  credential_id uuid references public.hyperliquid_credentials(id) on delete set null,
  event_type text not null,
  severity text not null default 'info' check (severity in ('info','warning','error')),
  symbol text,
  order_id text,
  client_order_id text,
  exchange_order_id text,
  latency_ms integer,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_hyperliquid_relay_events_user_time
  on public.hyperliquid_order_relay_events(user_id, created_at desc);

create index if not exists idx_hyperliquid_relay_events_account_time
  on public.hyperliquid_order_relay_events(account_id, created_at desc);

create index if not exists idx_hyperliquid_relay_events_order
  on public.hyperliquid_order_relay_events(order_id, client_order_id, exchange_order_id);

alter table public.hyperliquid_order_relay_events enable row level security;

create policy "hyperliquid_relay_events_select_own"
  on public.hyperliquid_order_relay_events for select
  using (auth.uid() = user_id);

create policy "hyperliquid_relay_events_insert_own"
  on public.hyperliquid_order_relay_events for insert
  with check (auth.uid() = user_id);

create table if not exists public.hyperliquid_account_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.exchange_accounts(id) on delete cascade,
  credential_id uuid references public.hyperliquid_credentials(id) on delete set null,
  network text not null check (network in ('mainnet','testnet')),
  master_wallet_address text not null,
  margin_summary jsonb not null default '{}'::jsonb,
  cross_margin_summary jsonb not null default '{}'::jsonb,
  positions jsonb not null default '[]'::jsonb,
  open_orders jsonb not null default '[]'::jsonb,
  fills jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_hyperliquid_snapshots_user_time
  on public.hyperliquid_account_snapshots(user_id, created_at desc);

create index if not exists idx_hyperliquid_snapshots_account_time
  on public.hyperliquid_account_snapshots(account_id, created_at desc);

alter table public.hyperliquid_account_snapshots enable row level security;

create policy "hyperliquid_snapshots_select_own"
  on public.hyperliquid_account_snapshots for select
  using (auth.uid() = user_id);

create policy "hyperliquid_snapshots_insert_own"
  on public.hyperliquid_account_snapshots for insert
  with check (auth.uid() = user_id);
```

## 2026-07-09 - Professional Network Foundation

Status: Required for Phase IV Preview.

Purpose:

- Store professional profile identity, avatar/banner metadata, and opt-in public performance disclosure flags.
- Store research feed posts, published indicators, published strategies, and follow graph data.
- Store Investment Groups, group stats, group members, join requests, Trading Room messages, and notification events.
- Enforce server-side ownership and group permission boundaries with RLS.
- Store only password hashes for password-protected groups.

SQL:

```sql
create extension if not exists pgcrypto;

create table if not exists public.profiles_extended (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  bio text not null default '',
  avatar_url text,
  banner_url text,
  country text,
  trading_style_tags jsonb not null default '[]'::jsonb,
  show_public_stats boolean not null default false,
  show_public_pnl boolean not null default false,
  show_public_drawdown boolean not null default false,
  show_public_equity_curve boolean not null default false,
  show_verified_exchange_performance boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles_extended enable row level security;

create policy "profiles_extended_select_public"
  on public.profiles_extended for select
  using (true);

create policy "profiles_extended_insert_own"
  on public.profiles_extended for insert
  with check (auth.uid() = user_id);

create policy "profiles_extended_update_own"
  on public.profiles_extended for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.user_follows (
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  followed_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_user_id, followed_user_id),
  check (follower_user_id <> followed_user_id)
);

create index if not exists idx_user_follows_followed
  on public.user_follows(followed_user_id, created_at desc);

alter table public.user_follows enable row level security;

create policy "user_follows_select_public"
  on public.user_follows for select
  using (true);

create policy "user_follows_insert_own"
  on public.user_follows for insert
  with check (auth.uid() = follower_user_id);

create policy "user_follows_delete_own"
  on public.user_follows for delete
  using (auth.uid() = follower_user_id);

create table if not exists public.profile_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  post_type text not null check (post_type in ('status','market_research','trade_idea','indicator_release','strategy_note','group_announcement')),
  body text not null,
  symbol text,
  timeframe text,
  visibility text not null default 'public' check (visibility in ('public','followers','private')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_profile_posts_user_time
  on public.profile_posts(user_id, created_at desc);

create index if not exists idx_profile_posts_visibility_time
  on public.profile_posts(visibility, created_at desc);

alter table public.profile_posts enable row level security;

create policy "profile_posts_select_visible"
  on public.profile_posts for select
  using (
    visibility = 'public'
    or auth.uid() = user_id
    or (
      visibility = 'followers'
      and exists (
        select 1
        from public.user_follows f
        where f.follower_user_id = auth.uid()
          and f.followed_user_id = profile_posts.user_id
      )
    )
  );

create policy "profile_posts_insert_own"
  on public.profile_posts for insert
  with check (auth.uid() = user_id);

create policy "profile_posts_update_own"
  on public.profile_posts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "profile_posts_delete_own"
  on public.profile_posts for delete
  using (auth.uid() = user_id);

create table if not exists public.published_indicators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  version text not null default '1.0.0',
  visibility text not null default 'public' check (visibility in ('public','followers','private')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_published_indicators_user_time
  on public.published_indicators(user_id, updated_at desc);

alter table public.published_indicators enable row level security;

create policy "published_indicators_select_visible"
  on public.published_indicators for select
  using (visibility = 'public' or auth.uid() = user_id);

create policy "published_indicators_insert_own"
  on public.published_indicators for insert
  with check (auth.uid() = user_id);

create policy "published_indicators_update_own"
  on public.published_indicators for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.published_strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  market text,
  timeframe text,
  risk_profile text not null default 'balanced' check (risk_profile in ('conservative','balanced','aggressive','custom')),
  visibility text not null default 'public' check (visibility in ('public','followers','private')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_published_strategies_user_time
  on public.published_strategies(user_id, updated_at desc);

alter table public.published_strategies enable row level security;

create policy "published_strategies_select_visible"
  on public.published_strategies for select
  using (visibility = 'public' or auth.uid() = user_id);

create policy "published_strategies_insert_own"
  on public.published_strategies for insert
  with check (auth.uid() = user_id);

create policy "published_strategies_update_own"
  on public.published_strategies for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.investment_groups (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  firm_name text not null,
  slug text not null unique,
  description text not null default '',
  bio text not null default '',
  logo_url text,
  banner_url text,
  visibility text not null default 'public' check (visibility in ('public','private','invite_only','password_protected')),
  access_mode text not null default 'approval_required' check (access_mode in ('open','approval_required','invite_only','password_protected')),
  password_hash text,
  trading_style_tags jsonb not null default '[]'::jsonb,
  accepted_exchanges jsonb not null default '[]'::jsonb,
  accepted_wallets jsonb not null default '[]'::jsonb,
  minimum_equity numeric,
  max_followers integer,
  approval_required boolean not null default true,
  status text not null default 'active' check (status in ('draft','active','suspended','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_investment_groups_owner_status
  on public.investment_groups(owner_user_id, status);

create index if not exists idx_investment_groups_visibility_status
  on public.investment_groups(visibility, status, created_at desc);

alter table public.investment_groups enable row level security;

create policy "investment_groups_select_visible"
  on public.investment_groups for select
  using (
    visibility = 'public'
    or auth.uid() = owner_user_id
  );

create policy "investment_groups_insert_own"
  on public.investment_groups for insert
  with check (auth.uid() = owner_user_id);

create policy "investment_groups_update_owner"
  on public.investment_groups for update
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create table if not exists public.investment_group_stats (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null unique references public.investment_groups(id) on delete cascade,
  follower_count integer not null default 0,
  connected_equity numeric not null default 0,
  monthly_return numeric,
  yearly_return numeric,
  total_return numeric,
  max_drawdown numeric,
  current_drawdown numeric,
  risk_score numeric,
  win_rate numeric,
  profit_factor numeric,
  average_trade_duration text,
  verified boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.investment_group_stats enable row level security;

create policy "investment_group_stats_select_visible"
  on public.investment_group_stats for select
  using (
    exists (
      select 1
      from public.investment_groups g
      where g.id = investment_group_stats.group_id
        and (g.visibility = 'public' or g.owner_user_id = auth.uid())
    )
  );

create policy "investment_group_stats_owner_write"
  on public.investment_group_stats for all
  using (
    exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_stats.group_id
        and g.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_stats.group_id
        and g.owner_user_id = auth.uid()
    )
  );

create table if not exists public.investment_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','manager','member')),
  status text not null default 'active' check (status in ('active','pending','removed')),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique(group_id, user_id)
);

create index if not exists idx_investment_group_members_user
  on public.investment_group_members(user_id, status);

alter table public.investment_group_members enable row level security;

create policy "investment_group_members_select_related"
  on public.investment_group_members for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_members.group_id
        and g.owner_user_id = auth.uid()
    )
  );

create policy "investment_group_members_owner_write"
  on public.investment_group_members for all
  using (
    exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_members.group_id
        and g.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_members.group_id
        and g.owner_user_id = auth.uid()
    )
  );

create table if not exists public.investment_group_join_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_investment_group_requests_group_status
  on public.investment_group_join_requests(group_id, status, created_at desc);

alter table public.investment_group_join_requests enable row level security;

create policy "investment_group_requests_select_related"
  on public.investment_group_join_requests for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_join_requests.group_id
        and g.owner_user_id = auth.uid()
    )
  );

create policy "investment_group_requests_insert_own"
  on public.investment_group_join_requests for insert
  with check (auth.uid() = user_id);

create policy "investment_group_requests_owner_update"
  on public.investment_group_join_requests for update
  using (
    exists (
      select 1 from public.investment_groups g
      where g.id = investment_group_join_requests.group_id
        and g.owner_user_id = auth.uid()
    )
  );

create table if not exists public.investment_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  channel text not null check (channel in ('announcements','general','research','trades')),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_investment_group_messages_group_channel
  on public.investment_group_messages(group_id, channel, created_at desc);

alter table public.investment_group_messages enable row level security;

create policy "investment_group_messages_select_members"
  on public.investment_group_messages for select
  using (
    exists (
      select 1 from public.investment_group_members m
      where m.group_id = investment_group_messages.group_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create policy "investment_group_messages_insert_members"
  on public.investment_group_messages for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.investment_group_members m
      where m.group_id = investment_group_messages.group_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  title text not null,
  body text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notification_events_user_time
  on public.notification_events(user_id, created_at desc);

alter table public.notification_events enable row level security;

create policy "notification_events_select_own"
  on public.notification_events for select
  using (auth.uid() = user_id);

create policy "notification_events_update_own"
  on public.notification_events for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

## 2026-07-09 - DOM Pro+

Status: No Supabase migration required.

Reason:

- DOM Pro+ currently persists settings in local browser storage per workspace and symbol.
- It consumes live orderbook, trade, and ticker data from the Black Core Market Data Engine.
- The institutional macro radar uses historical candles fetched through the existing Market Data Engine cache and adapter path.
- Heatmap horizon, macro radar, bucket, FPS, and persistence settings remain local workspace settings.
- It does not introduce user-owned server records, credentials, audit tables, or permission tables yet.

Future migration trigger:

- Add a Supabase migration only if DOM layouts, detached window geometry, DOM presets, heatmap history, or cross-device order-flow workspaces need server persistence.

## 2026-07-10 - DOM Pro+ Polish Sprint

Status: No Supabase migration required.

Reason:

- This sprint only changes the DOM Pro+ frontend renderer, local DOM settings, viewport math, and visual diagnostics.
- Heatmap viewport, CVD horizon/smoothing, cumulative depth, and liquidity-flow histogram state remain derived from live market data in the browser.
- No new user-owned server records, execution audit records, credentials, or permission tables were introduced.

Future migration trigger:

- Add a migration if DOM Pro+ presets, saved heatmap viewports, detached cockpit geometry, or cross-device DOM workspace layouts need account-level persistence.

## 2026-07-10 - DOM Pro+ Viewport Refinement

Status: No Supabase migration required.

Reason:

- The shared heatmap, volume profile, and depth chart camera is local frontend viewport state.
- Camera presets, fit-to-data behavior, and user pan/zoom do not introduce server-owned records.
- No credentials, execution audit rows, account records, or persistent workspace tables were added.

Future migration trigger:

- Add a migration only if saved DOM camera presets, per-user viewport layouts, minimap state, or cross-device DOM Pro+ workspaces need Supabase persistence.

## 2026-07-10 - DOM Pro+ Full Price Domain Fix

Status: No Supabase migration required.

Reason:

- The fix is limited to local DOM aggregation, shared price-domain rendering, diagnostics, and depth-chart visualization.
- No server-owned records, credentials, execution audit rows, or persistent workspace tables were introduced.

Future migration trigger:

- Add a migration only if DOM diagnostics snapshots, saved camera domains, or cross-device DOM Pro+ layouts need account-level persistence.

## 2026-07-10 - DOM Pro+ Real Liquidity Camera

Status: No Supabase migration required.

Reason:

- The real price-domain camera, widened range presets, retained aggregation buckets, hard diagnostics, raw-depth fallback, and flow-delta scaling are frontend/domain-rendering changes.
- No server-owned records, user permissions, execution audit rows, credentials, or persistent workspace tables were introduced.

Future migration trigger:

- Add a migration only if camera presets, saved viewport domains, diagnostics snapshots, or cross-device DOM Pro+ layouts need account-level Supabase persistence.

## 2026-07-10 - DOM Pro+ Profile And Depth Curve Fix

Status: No Supabase migration required.

Reason:

- The change is limited to frontend DOM Pro+ rendering and depth/profile derivation from already available market data.
- Volume Profile now keeps a full camera-domain scaffold locally.
- Depth Chart now consumes raw L2 levels before falling back to aggregated buckets.
- No new server records, account settings, credentials, audit rows, or Supabase policies were introduced.

Future migration trigger:

- Add a migration only if per-user saved DOM camera layouts, DOM diagnostics snapshots, or cross-device order-flow workspace presets need Supabase persistence.

## 2026-07-10 - DOM Pro+ Heatmap Drag And Downside Structure Fix

Status: No Supabase migration required.

Reason:

- The change is limited to frontend heatmap rendering, profile-derived historical structure ribbons, and drag/pan event safety.
- It does not introduce stored user settings, credentials, execution records, account records, or audit tables.

Future migration trigger:

- Add a migration only if heatmap camera presets, saved DOM layout state, or historical depth snapshots need account-level Supabase persistence.

## 2026-07-10 - DOM Pro+ Depth Memory Provider

Status: Supabase migration required for cloud depth memory. Local browser depth memory works without this migration.

Purpose:

- Store compact, per-user market depth wall memory over time.
- Preserve observed bid/ask liquidity buckets so DOM Pro+ becomes more powerful the longer it runs.
- Keep raw market feed data compressed into institutional wall-memory points instead of writing every orderbook tick.

Run this SQL in Supabase:

```sql
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
```

Notes:

- DOM Pro+ hydrates previously collected wall memory on startup and writes compact wall-memory points only once per throttled interval.
- If this table is missing, the frontend silently falls back to local browser depth memory and does not break the terminal.

## 2026-07-10 - Black Core Market Depth Memory / IMM Foundation

Status: Supabase migration required for server-owned market memory.

Purpose:

- Store Black Core market depth memory as platform-owned time-series records.
- Support continuous server-side depth ingestion, compressed replay, wall lifecycle, liquidity events, and statistics.
- Keep DOM Pro+ as a viewer of server-owned market memory instead of the owner of long-term history.

Run this SQL in Supabase after the previous DOM Pro+ depth-memory migration:

```sql
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
```

Notes:

- These are platform market-memory tables, not user-owned portfolio/account tables.
- Direct browser access is intentionally blocked by RLS. The Vercel API and collector worker read/write through `SUPABASE_SERVICE_ROLE_KEY`.
- Run a persistent worker with `npm run depth:worker`; Vercel serverless routes cannot own continuous WebSocket sessions.

## 2026-07-10 - IMM Retention And Alert Surfaces

Status: No additional Supabase migration required.

Reason:

- Retention pruning deletes from the existing IMM tables created by the Black Core Market Depth Memory migration.
- Alert extraction reads from existing `market_liquidity_events`, `market_liquidity_walls`, and `market_depth_statistics`.
- Collector packet-loss/reconnect diagnostics are stored in existing `market_depth_statistics` columns.

Operational notes:

- Use `/api/market-depth/alerts` to expose normalized market-memory alerts for Scanner, BlackGPT, Notifications, and future automation.
- Use `/api/market-depth/prune` with `MARKET_DEPTH_MAINTENANCE_TOKEN` or `MARKET_DEPTH_INGEST_TOKEN` to run retention manually.
- The persistent worker also runs pruning on `MARKET_DEPTH_PRUNE_INTERVAL_MS`.

## 2026-07-10 - IMM Tiles And Collector Heartbeat

Status: Supabase migration required for collector heartbeat only.

Purpose:

- Track persistent depth collector worker health.
- Let `/api/market-depth/status` report whether Black Core market memory is actively being collected.
- Support operations checks without relying only on recent market statistics.

Run this SQL after the Black Core Market Depth Memory migration:

```sql
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
```

Notes:

- The table is platform-owned. Direct browser access is intentionally blocked by RLS.
- `/api/market-depth/tiles` uses the existing rollup tables and does not require extra schema.
- DOM Pro+ browser depth memory no longer writes to Supabase unless `VITE_DOM_DEPTH_BROWSER_SYNC=true` is explicitly set.

## 2026-07-10 - IMM Replay Worker Bridge

Status: No Supabase migration required.

Reason:

- This is a frontend worker/offload change for shaping replay points before DOM Pro+ consumes them.
- It does not introduce new persistence, credentials, permissions, or server-owned records.

## 2026-07-10 - IMM Collector Snapshot Recovery

Status: No Supabase migration required.

Reason:

- Snapshot recovery writes through existing `market_depth_snapshots`, `market_depth_rollups`, `market_depth_statistics`, `market_liquidity_walls`, and `market_liquidity_events`.
- Recovery counters and reasons are stored inside existing statistics metadata.

## 2026-07-10 - DOM Pro Tile Hydration

Status: No Supabase migration required.

Reason:

- DOM Pro+ now requests `/api/market-depth/tiles` for the active camera range before falling back to replay hydration.
- The tile route reads existing `market_depth_rollups` records and does not introduce new persisted fields, policies, tables, or indexes.

## 2026-07-10 - IMM Progressive Tile Prefetch

Status: No Supabase migration required.

Reason:

- DOM Pro+ now pads tile requests around the active camera window to preload adjacent market-memory cells for map-style pan/zoom.
- This only changes the client query window against existing `market_depth_rollups` data.

## 2026-07-10 - Supervised IMM Depth Worker

Status: No Supabase migration required.

Reason:

- `npm run depth:worker:supervise` adds process supervision around the existing market-depth worker.
- Worker stale-feed exits and supervisor restarts reuse the existing `market_depth_collector_status` heartbeat table and existing market-memory tables.

## 2026-07-10 - IMM Operational Readiness Tables

Status: Supabase migration required.

Purpose:

- Store normalized IMM worker heartbeats independent of the browser.
- Store orderbook integrity failures and warnings so corrupted depth can be rejected and audited.
- Support `/api/imm/status` and `npm run depth:verify`.

Run this SQL after the IMM collector heartbeat migration:

```sql
create table if not exists public.imm_worker_heartbeats (
  id text primary key,
  worker_instance_id text not null,
  hostname text,
  process_id integer,
  version integer not null default 1,
  venue text not null,
  market_kind text not null,
  symbol text not null,
  status text not null default 'unavailable'
    check (status in ('healthy','degraded','reconnecting','stale','unavailable','misconfigured','error')),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  last_message_at timestamptz,
  last_persist_at timestamptz,
  reconnect_count integer not null default 0 check (reconnect_count >= 0),
  sequence_gap_count integer not null default 0 check (sequence_gap_count >= 0),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_imm_worker_heartbeats_symbol
  on public.imm_worker_heartbeats(venue, market_kind, symbol, heartbeat_at desc);

create index if not exists idx_imm_worker_heartbeats_status
  on public.imm_worker_heartbeats(status, heartbeat_at desc);

alter table public.imm_worker_heartbeats enable row level security;

create table if not exists public.imm_integrity_events (
  id uuid primary key default gen_random_uuid(),
  venue text not null,
  market_kind text not null,
  symbol text not null,
  severity text not null default 'error' check (severity in ('warning','error')),
  reason text not null,
  sequence text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_imm_integrity_events_symbol_time
  on public.imm_integrity_events(venue, market_kind, symbol, occurred_at desc);

create index if not exists idx_imm_integrity_events_severity_time
  on public.imm_integrity_events(severity, occurred_at desc);

alter table public.imm_integrity_events enable row level security;
```

Notes:

- These are platform-owned operational tables.
- Direct browser access is intentionally blocked by RLS.
- Server routes and workers access these records through `SUPABASE_SERVICE_ROLE_KEY`.

## 2026-07-10 - IMM Polish And Professional UX

Status: No Supabase migration required.

Reason:

- DOM Pro+ workspace presets, follow/free-explore mode, depth-chart visibility, keyboard shortcuts, and the IMM status strip are frontend/local workspace behavior.
- The status strip consumes the existing `/api/imm/status` service and existing IMM operational tables.
- No new server-owned records, credentials, execution audit rows, account tables, or market-memory tables were introduced.

Future migration trigger:

- Add a Supabase migration only if DOM Pro+ presets, camera state, resizable panel layouts, or cross-device order-flow workspaces need account-level persistence.
