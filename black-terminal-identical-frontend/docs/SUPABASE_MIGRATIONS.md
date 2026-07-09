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
