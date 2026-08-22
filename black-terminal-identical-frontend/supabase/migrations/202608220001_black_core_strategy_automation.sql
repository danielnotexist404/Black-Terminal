-- Black Core Strategy Automation Engine: persistent named strategies, paper
-- execution, and a bounded ten-slot live target matrix. Browser roles have no
-- direct write authority; mutations flow through the authenticated API.
begin;

create extension if not exists pgcrypto;

create table if not exists public.strategy_automation_strategies (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  runtime_kind text not null check (runtime_kind in ('builtin-ema-cross','builtin-adaptive-swing','python-script','external-signals')),
  symbol text not null check (length(symbol) between 2 and 40),
  timeframe text not null check (length(timeframe) between 1 and 12),
  market_type text not null check (market_type in ('SPOT','FUTURES')),
  exchange text not null default 'bybit',
  current_version integer not null default 1 check (current_version > 0),
  definition jsonb not null default '{}'::jsonb check (jsonb_typeof(definition)='object'),
  global_capital_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(global_capital_policy)='object'),
  status text not null default 'PAPER_ACTIVE' check (status in ('DRAFT','PAPER_ACTIVE','PAPER_PAUSED','LIVE_READY','LIVE_ACTIVE','PAUSED','STOPPED','DEGRADED','ERROR')),
  idempotency_key text,
  request_hash text not null check (length(request_hash)=64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique(owner_user_id,idempotency_key)
);
create unique index if not exists idx_strategy_automation_owner_name
  on public.strategy_automation_strategies(owner_user_id,lower(name)) where archived_at is null;
create index if not exists idx_strategy_automation_owner_status
  on public.strategy_automation_strategies(owner_user_id,status,updated_at desc);

create table if not exists public.strategy_automation_save_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null check (length(request_hash)=64),
  strategy_version integer not null check (strategy_version > 0),
  created_at timestamptz not null default now(),
  unique(owner_user_id,idempotency_key)
);

create table if not exists public.strategy_automation_versions (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  name text not null check (length(btrim(name)) between 1 and 80),
  definition jsonb not null check (jsonb_typeof(definition)='object'),
  global_capital_policy jsonb not null check (jsonb_typeof(global_capital_policy)='object'),
  canonical_hash text not null check (length(canonical_hash)=64),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED','ARCHIVED')),
  created_at timestamptz not null default now(),
  unique(strategy_id,version)
);

create table if not exists public.strategy_paper_accounts (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  strategy_version integer not null check (strategy_version > 0),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  market_type text not null check (market_type in ('SPOT','FUTURES')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','STOPPED','DEGRADED','ERROR')),
  demo_equity numeric not null default 10000 check (demo_equity >= 0),
  available_balance numeric not null default 10000 check (available_balance >= 0),
  used_strategy_capital numeric not null default 0 check (used_strategy_capital >= 0),
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  fees numeric not null default 0 check (fees >= 0),
  funding numeric not null default 0,
  capital_policy_version integer not null default 1 check (capital_policy_version > 0),
  state_version bigint not null default 1 check (state_version > 0),
  capital_policy jsonb not null check (jsonb_typeof(capital_policy)='object'),
  peak_equity numeric not null default 10000 check (peak_equity >= 0),
  maximum_drawdown_percent numeric not null default 0 check (maximum_drawdown_percent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(strategy_id,strategy_version)
);

create table if not exists public.strategy_target_bindings (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  strategy_version integer not null check (strategy_version > 0),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  slot_index integer not null check (slot_index between 1 and 10),
  target_type text not null check (target_type in ('BROKER_ACCOUNT','INVESTMENT_GROUP')),
  target_id uuid not null,
  connection_id uuid references public.connectivity_connections(id) on delete restrict,
  account_id uuid references public.exchange_accounts(id) on delete restrict,
  group_id uuid references public.investment_groups(id) on delete restrict,
  market_type text not null check (market_type in ('SPOT','FUTURES')),
  status text not null default 'PENDING' check (status in ('PENDING','READY','LIVE','PAUSED','DEGRADED','RISK_SUSPENDED','DISCONNECTING','DISCONNECTED','ERROR')),
  capital_policy_version integer not null default 1 check (capital_policy_version > 0),
  strategy_allocation_mode text not null check (strategy_allocation_mode in ('PERCENT_ACCOUNT_EQUITY','FIXED_USDT')),
  strategy_allocation_value numeric not null default 0 check (strategy_allocation_value >= 0),
  trade_amount_mode text not null check (trade_amount_mode in ('PERCENT_ACCOUNT_EQUITY','PERCENT_STRATEGY_ALLOCATION','RISK_PERCENT','FIXED_USDT','FIXED_QUANTITY','VOLATILITY_TARGET')),
  trade_amount_value numeric not null default 0 check (trade_amount_value >= 0),
  requested_leverage numeric check (requested_leverage is null or requested_leverage >= 1),
  maximum_leverage numeric check (maximum_leverage is null or maximum_leverage >= 1),
  maximum_position_percent numeric not null default 0 check (maximum_position_percent between 0 and 100),
  maximum_exposure_percent numeric not null default 0 check (maximum_exposure_percent between 0 and 100),
  maximum_daily_loss numeric not null default 0 check (maximum_daily_loss >= 0),
  maximum_drawdown numeric not null default 0 check (maximum_drawdown between 0 and 100),
  maximum_positions integer not null default 1 check (maximum_positions between 1 and 1000),
  slippage_bps numeric not null default 5 check (slippage_bps between 0 and 10000),
  margin_mode text check (margin_mode is null or margin_mode in ('CROSS','ISOLATED')),
  quote_asset_reserve_percent numeric check (quote_asset_reserve_percent is null or quote_asset_reserve_percent between 0 and 100),
  maximum_base_asset_exposure_percent numeric check (maximum_base_asset_exposure_percent is null or maximum_base_asset_exposure_percent between 0 and 100),
  validation_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_snapshot)='object'),
  row_version integer not null default 1 check (row_version > 0),
  idempotency_key text,
  request_hash text not null check (length(request_hash)=64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  armed_at timestamptz,
  paused_at timestamptz,
  disconnected_at timestamptz,
  disconnect_policy text check (disconnect_policy is null or disconnect_policy in ('DETACH_MANUAL','CLOSE_STRATEGY_POSITIONS','KEEP_PROTECTED','DISCONNECT_WHEN_FLAT')),
  check ((target_type='BROKER_ACCOUNT' and connection_id is not null and account_id is not null and group_id is null and target_id=connection_id)
      or (target_type='INVESTMENT_GROUP' and group_id is not null and connection_id is null and account_id is null and target_id=group_id)),
  check ((market_type='SPOT' and requested_leverage is null and maximum_leverage is null and margin_mode is null and quote_asset_reserve_percent is not null and maximum_base_asset_exposure_percent is not null)
      or (market_type='FUTURES' and requested_leverage is not null and maximum_leverage is not null and margin_mode is not null and quote_asset_reserve_percent is null and maximum_base_asset_exposure_percent is null)),
  unique(owner_user_id,idempotency_key)
);

create table if not exists public.strategy_paper_mutation_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  paper_account_id uuid not null references public.strategy_paper_accounts(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null check (length(request_hash)=64),
  state_version bigint not null check (state_version > 0),
  created_at timestamptz not null default now(),
  unique(owner_user_id,idempotency_key)
);

create table if not exists public.strategy_target_mutation_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  binding_id uuid not null references public.strategy_target_bindings(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null check (length(request_hash)=64),
  row_version integer not null check (row_version > 0),
  target_status text not null,
  created_at timestamptz not null default now(),
  unique(owner_user_id,idempotency_key)
);

create table if not exists public.strategy_target_reorder_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  strategy_version integer not null check (strategy_version > 0),
  idempotency_key text not null,
  request_hash text not null check (length(request_hash)=64),
  result_snapshot jsonb not null check (jsonb_typeof(result_snapshot)='array'),
  created_at timestamptz not null default now(),
  unique(owner_user_id,idempotency_key)
);
create unique index if not exists idx_strategy_target_active_slot
  on public.strategy_target_bindings(strategy_id,strategy_version,slot_index) where status <> 'DISCONNECTED';
create unique index if not exists idx_strategy_target_active_identity
  on public.strategy_target_bindings(strategy_id,strategy_version,target_type,target_id) where status <> 'DISCONNECTED';
create index if not exists idx_strategy_target_runtime
  on public.strategy_target_bindings(strategy_id,status,updated_at) where status <> 'DISCONNECTED';

create table if not exists public.strategy_target_policy_versions (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.strategy_target_bindings(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  policy_snapshot jsonb not null check (jsonb_typeof(policy_snapshot)='object'),
  canonical_hash text not null check (length(canonical_hash)=64),
  change_kind text not null check (change_kind in ('CREATED','RISK_REDUCED','RISK_INCREASED','REVALIDATED')),
  created_at timestamptz not null default now(),
  unique(binding_id,version)
);

create table if not exists public.strategy_target_snapshots (
  binding_id uuid primary key references public.strategy_target_bindings(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  freshness text not null default 'UNAVAILABLE' check (freshness in ('LIVE','STALE','DEGRADED','UNAVAILABLE')),
  snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot)='object'),
  captured_at timestamptz not null default now()
);

create table if not exists public.strategy_paper_positions (
  id uuid primary key default gen_random_uuid(),
  paper_account_id uuid not null references public.strategy_paper_accounts(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  quantity numeric not null check (quantity > 0),
  entry_price numeric not null check (entry_price > 0),
  mark_price numeric not null check (mark_price > 0),
  leverage numeric not null default 1 check (leverage >= 1),
  margin_used numeric not null check (margin_used >= 0),
  entry_fee numeric not null default 0 check (entry_fee >= 0),
  liquidation_price numeric,
  stop_loss numeric,
  take_profit numeric,
  unrealized_pnl numeric not null default 0,
  signal_key text not null,
  opened_at timestamptz not null,
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index if not exists idx_strategy_paper_one_open_position
  on public.strategy_paper_positions(paper_account_id,symbol) where closed_at is null;

create table if not exists public.strategy_paper_orders (
  id uuid primary key default gen_random_uuid(),
  paper_account_id uuid not null references public.strategy_paper_accounts(id) on delete cascade,
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  signal_key text not null,
  symbol text not null,
  side text not null check (side in ('BUY','SELL')),
  order_type text not null check (order_type in ('MARKET','LIMIT','STOP')),
  quantity numeric not null check (quantity > 0),
  requested_price numeric,
  filled_price numeric,
  status text not null check (status in ('CREATED','FILLED','CANCELLED','REJECTED')),
  rejection_reason text,
  created_at timestamptz not null default now(),
  filled_at timestamptz,
  unique(paper_account_id,signal_key)
);

create table if not exists public.strategy_automation_executions (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid references public.strategy_target_bindings(id) on delete set null,
  paper_account_id uuid references public.strategy_paper_accounts(id) on delete set null,
  mode text not null check (mode in ('PAPER','LIVE')),
  external_execution_id text,
  symbol text not null,
  side text not null,
  quantity numeric not null check (quantity > 0),
  price numeric not null check (price > 0),
  fee numeric not null default 0,
  funding numeric not null default 0,
  realized_pnl numeric not null default 0,
  signal_key text not null,
  executed_at timestamptz not null,
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata)='object')
);
create unique index if not exists idx_strategy_paper_execution_signal
  on public.strategy_automation_executions(paper_account_id,signal_key,side) where mode='PAPER';
create unique index if not exists idx_strategy_live_execution_signal
  on public.strategy_automation_executions(binding_id,signal_key,side) where mode='LIVE';

create table if not exists public.strategy_automation_trades (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid references public.strategy_target_bindings(id) on delete set null,
  paper_account_id uuid references public.strategy_paper_accounts(id) on delete set null,
  mode text not null check (mode in ('PAPER','LIVE')),
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  quantity numeric not null check (quantity > 0),
  entry_price numeric not null check (entry_price > 0),
  exit_price numeric not null check (exit_price > 0),
  gross_pnl numeric not null,
  fees numeric not null default 0,
  funding numeric not null default 0,
  net_pnl numeric not null,
  entry_signal_key text not null,
  exit_reason text not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null
);
create unique index if not exists idx_strategy_paper_trade_signal
  on public.strategy_automation_trades(paper_account_id,entry_signal_key) where mode='PAPER';
create unique index if not exists idx_strategy_live_trade_signal
  on public.strategy_automation_trades(binding_id,entry_signal_key) where mode='LIVE';

create table if not exists public.strategy_automation_runtime_state (
  strategy_id uuid primary key references public.strategy_automation_strategies(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  runtime_state text not null default 'STARTING' check (runtime_state in ('STARTING','LIVE','PAUSED','DEGRADED','ERROR','STOPPED')),
  state_version bigint not null default 1,
  last_closed_candle_at timestamptz,
  last_signal_key text,
  last_signal_at timestamptz,
  last_heartbeat_at timestamptz,
  worker_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  safe_error_code text,
  updated_at timestamptz not null default now()
);

create table if not exists public.strategy_automation_audit_events (
  id bigint generated always as identity primary key,
  owner_user_id uuid references auth.users(id) on delete set null,
  strategy_id uuid references public.strategy_automation_strategies(id) on delete set null,
  binding_id uuid references public.strategy_target_bindings(id) on delete set null,
  event_type text not null,
  severity text not null default 'INFO' check (severity in ('INFO','WARNING','ERROR','CRITICAL')),
  message text not null,
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata)='object'),
  created_at timestamptz not null default now()
);
create index if not exists idx_strategy_automation_audit_owner_time
  on public.strategy_automation_audit_events(owner_user_id,created_at desc);

create or replace function public.black_core_create_strategy(
  p_owner_user_id uuid,
  p_name text,
  p_definition jsonb,
  p_global_policy jsonb,
  p_paper_policy jsonb,
  p_canonical_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  existing_id uuid;
  existing_hash text;
  created_strategy public.strategy_automation_strategies;
  paper_account public.strategy_paper_accounts;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if length(btrim(p_name)) not between 1 and 80 then raise exception 'invalid strategy name' using errcode='22023'; end if;
  if length(p_canonical_hash) <> 64 then raise exception 'invalid strategy hash' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-create:'||p_owner_user_id::text||':'||p_idempotency_key,0));
  select id,request_hash into existing_id,existing_hash from public.strategy_automation_strategies where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if existing_id is not null then
    if existing_hash <> p_canonical_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('strategyId',existing_id,'idempotent',true);
  end if;
  insert into public.strategy_automation_strategies(
    owner_user_id,name,runtime_kind,symbol,timeframe,market_type,exchange,definition,global_capital_policy,idempotency_key,request_hash
  ) values (
    p_owner_user_id,btrim(p_name),p_definition->>'runtimeKind',p_definition->>'symbol',p_definition->>'timeframe',p_definition->>'marketType',coalesce(p_definition->>'exchange','bybit'),p_definition,p_global_policy,p_idempotency_key,p_canonical_hash
  ) returning * into created_strategy;
  insert into public.strategy_automation_versions(strategy_id,owner_user_id,version,name,definition,global_capital_policy,canonical_hash)
  values(created_strategy.id,p_owner_user_id,1,created_strategy.name,p_definition,p_global_policy,p_canonical_hash);
  insert into public.strategy_paper_accounts(strategy_id,strategy_version,owner_user_id,market_type,capital_policy)
  values(created_strategy.id,1,p_owner_user_id,created_strategy.market_type,p_paper_policy) returning * into paper_account;
  insert into public.strategy_automation_runtime_state(strategy_id,owner_user_id,runtime_state)
  values(created_strategy.id,p_owner_user_id,'STARTING');
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,created_strategy.id,'STRATEGY_CREATED','A named strategy and separate paper target were created.',jsonb_build_object('name',created_strategy.name,'version',1,'liveTargetRows',0));
  return jsonb_build_object('strategyId',created_strategy.id,'paperAccountId',paper_account.id,'idempotent',false);
end;
$$;

create or replace function public.black_core_claim_strategy_runtime(
  p_strategy_id uuid,
  p_owner_user_id uuid,
  p_worker_id text,
  p_lease_seconds integer
)
returns boolean language plpgsql security definer set search_path=public as $$
declare runtime_row public.strategy_automation_runtime_state;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if p_lease_seconds not between 5 and 300 then raise exception 'invalid strategy lease duration' using errcode='22023'; end if;
  select * into runtime_row from public.strategy_automation_runtime_state
    where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id for update;
  if runtime_row.strategy_id is null then return false; end if;
  if runtime_row.lease_expires_at is not null and runtime_row.lease_expires_at>now() and runtime_row.lease_owner<>p_worker_id then return false; end if;
  update public.strategy_automation_runtime_state set lease_owner=p_worker_id,
    lease_expires_at=now()+make_interval(secs=>p_lease_seconds),worker_id=p_worker_id,last_heartbeat_at=now()
    where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id;
  return true;
end;
$$;

create or replace function public.black_core_save_strategy(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_name text,
  p_definition jsonb,
  p_global_policy jsonb,
  p_paper_policy jsonb,
  p_canonical_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  strategy_row public.strategy_automation_strategies;
  existing_request public.strategy_automation_save_requests;
  latest_hash text;
  next_version integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if length(btrim(p_name)) not between 1 and 80 then raise exception 'invalid strategy name' using errcode='22023'; end if;
  if length(p_canonical_hash) <> 64 then raise exception 'invalid strategy hash' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-save:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies
    where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  select * into existing_request from public.strategy_automation_save_requests
    where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if existing_request.id is not null then
    if existing_request.strategy_id <> p_strategy_id or existing_request.request_hash <> p_canonical_hash then
      raise exception 'idempotency key payload mismatch' using errcode='22023';
    end if;
    return jsonb_build_object('strategyId',p_strategy_id,'strategyVersion',existing_request.strategy_version,'idempotent',true);
  end if;
  if strategy_row.status='LIVE_ACTIVE' then raise exception 'live strategy version is locked' using errcode='55000'; end if;
  select canonical_hash into latest_hash from public.strategy_automation_versions
    where strategy_id=p_strategy_id and version=strategy_row.current_version;
  if latest_hash=p_canonical_hash then
    insert into public.strategy_automation_save_requests(owner_user_id,strategy_id,idempotency_key,request_hash,strategy_version)
    values(p_owner_user_id,p_strategy_id,p_idempotency_key,p_canonical_hash,strategy_row.current_version);
    return jsonb_build_object('strategyId',p_strategy_id,'strategyVersion',strategy_row.current_version,'idempotent',true);
  end if;
  next_version := strategy_row.current_version+1;
  update public.strategy_automation_strategies set
    name=btrim(p_name),runtime_kind=p_definition->>'runtimeKind',symbol=p_definition->>'symbol',timeframe=p_definition->>'timeframe',
    market_type=p_definition->>'marketType',exchange=coalesce(p_definition->>'exchange','bybit'),definition=p_definition,
    global_capital_policy=p_global_policy,current_version=next_version,status='PAPER_ACTIVE'
  where id=p_strategy_id;
  insert into public.strategy_automation_versions(strategy_id,owner_user_id,version,name,definition,global_capital_policy,canonical_hash)
  values(p_strategy_id,p_owner_user_id,next_version,btrim(p_name),p_definition,p_global_policy,p_canonical_hash);
  insert into public.strategy_paper_accounts(strategy_id,strategy_version,owner_user_id,market_type,capital_policy)
  values(p_strategy_id,next_version,p_owner_user_id,p_definition->>'marketType',p_paper_policy);
  update public.strategy_automation_runtime_state set runtime_state='STARTING',state_version=state_version+1,
    last_closed_candle_at=null,last_signal_key=null,last_signal_at=null,last_heartbeat_at=null,worker_id=null,
    lease_owner=null,lease_expires_at=null,safe_error_code=null
  where strategy_id=p_strategy_id and owner_user_id=p_owner_user_id;
  insert into public.strategy_automation_save_requests(owner_user_id,strategy_id,idempotency_key,request_hash,strategy_version)
  values(p_owner_user_id,p_strategy_id,p_idempotency_key,p_canonical_hash,next_version);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'STRATEGY_VERSION_SAVED','An immutable named strategy version was saved with a fresh Paper Target and ten empty live slots.',
    jsonb_build_object('name',btrim(p_name),'previousVersion',strategy_row.current_version,'version',next_version,'liveTargetRows',0));
  return jsonb_build_object('strategyId',p_strategy_id,'strategyVersion',next_version,'idempotent',false);
end;
$$;

create or replace function public.black_core_add_strategy_target(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_strategy_version integer,
  p_slot_index integer,
  p_target_type text,
  p_target_id uuid,
  p_connection_id uuid,
  p_account_id uuid,
  p_group_id uuid,
  p_market_type text,
  p_policy jsonb,
  p_validation jsonb,
  p_canonical_hash text,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  strategy_row public.strategy_automation_strategies;
  existing_id uuid;
  existing_hash text;
  created_binding public.strategy_target_bindings;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if p_slot_index not between 1 and 10 then raise exception 'invalid target slot' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-target:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  if strategy_row.current_version <> p_strategy_version then raise exception 'strategy version conflict' using errcode='40001'; end if;
  select id,request_hash into existing_id,existing_hash from public.strategy_target_bindings where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if existing_id is not null then
    if existing_hash <> p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',existing_id,'idempotent',true);
  end if;
  if (select count(*) from public.strategy_target_bindings where strategy_id=p_strategy_id and strategy_version=p_strategy_version and status<>'DISCONNECTED') >= 10 then
    raise exception 'live target capacity reached' using errcode='23514';
  end if;
  insert into public.strategy_target_bindings(
    strategy_id,strategy_version,owner_user_id,slot_index,target_type,target_id,connection_id,account_id,group_id,market_type,status,
    strategy_allocation_mode,strategy_allocation_value,trade_amount_mode,trade_amount_value,requested_leverage,maximum_leverage,
    maximum_position_percent,maximum_exposure_percent,maximum_daily_loss,maximum_drawdown,maximum_positions,slippage_bps,margin_mode,
    quote_asset_reserve_percent,maximum_base_asset_exposure_percent,
    validation_snapshot,idempotency_key,request_hash
  ) values (
    p_strategy_id,p_strategy_version,p_owner_user_id,p_slot_index,p_target_type,p_target_id,p_connection_id,p_account_id,p_group_id,p_market_type,'READY',
    p_policy->>'strategyAllocationMode',(p_policy->>'strategyAllocationValue')::numeric,p_policy->>'tradeAmountMode',(p_policy->>'tradeAmountValue')::numeric,
    nullif(p_policy->>'requestedLeverage','')::numeric,nullif(p_policy->>'maximumLeverage','')::numeric,
    (p_policy->>'maximumPositionPercent')::numeric,(p_policy->>'maximumExposurePercent')::numeric,(p_policy->>'maximumDailyLoss')::numeric,
    (p_policy->>'maximumDrawdown')::numeric,(p_policy->>'maximumPositions')::integer,(p_policy->>'slippageBps')::numeric,nullif(p_policy->>'marginMode',''),
    nullif(p_policy->>'quoteAssetReservePercent','')::numeric,nullif(p_policy->>'maximumBaseAssetExposurePercent','')::numeric,
    p_validation,p_idempotency_key,p_request_hash
  ) returning * into created_binding;
  insert into public.strategy_target_policy_versions(binding_id,strategy_id,owner_user_id,version,policy_snapshot,canonical_hash,change_kind)
  values(created_binding.id,p_strategy_id,p_owner_user_id,1,p_policy,p_canonical_hash,'CREATED');
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,created_binding.id,'STRATEGY_TARGET_ADDED','A validated strategy target occupied a live slot.',jsonb_build_object('slotIndex',p_slot_index,'targetType',p_target_type,'marketType',p_market_type,'allocation',0));
  return jsonb_build_object('bindingId',created_binding.id,'idempotent',false);
end;
$$;

create or replace function public.black_core_paper_open_position(
  p_paper_account_id uuid,
  p_strategy_id uuid,
  p_owner_user_id uuid,
  p_signal_key text,
  p_symbol text,
  p_side text,
  p_quantity numeric,
  p_entry_price numeric,
  p_leverage numeric,
  p_margin_used numeric,
  p_liquidation_price numeric,
  p_stop_loss numeric,
  p_take_profit numeric,
  p_entry_fee numeric,
  p_opened_at timestamptz
)
returns boolean language plpgsql security definer set search_path=public as $$
declare paper public.strategy_paper_accounts;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('paper:'||p_paper_account_id::text,0));
  select * into paper from public.strategy_paper_accounts where id=p_paper_account_id and strategy_id=p_strategy_id and owner_user_id=p_owner_user_id for update;
  if paper.id is null or paper.status <> 'ACTIVE' then return false; end if;
  if exists(select 1 from public.strategy_paper_orders where paper_account_id=p_paper_account_id and signal_key=p_signal_key) then return false; end if;
  if exists(select 1 from public.strategy_paper_positions where paper_account_id=p_paper_account_id and symbol=p_symbol and closed_at is null) then return false; end if;
  if p_quantity<=0 or p_entry_price<=0 or p_margin_used<0 or p_entry_fee<0 or paper.available_balance < p_margin_used+p_entry_fee then return false; end if;
  insert into public.strategy_paper_orders(paper_account_id,strategy_id,owner_user_id,signal_key,symbol,side,order_type,quantity,requested_price,filled_price,status,created_at,filled_at)
  values(p_paper_account_id,p_strategy_id,p_owner_user_id,p_signal_key,p_symbol,case when p_side='LONG' then 'BUY' else 'SELL' end,'MARKET',p_quantity,p_entry_price,p_entry_price,'FILLED',p_opened_at,p_opened_at);
  insert into public.strategy_paper_positions(paper_account_id,strategy_id,owner_user_id,symbol,side,quantity,entry_price,mark_price,leverage,margin_used,entry_fee,liquidation_price,stop_loss,take_profit,signal_key,opened_at)
  values(p_paper_account_id,p_strategy_id,p_owner_user_id,p_symbol,p_side,p_quantity,p_entry_price,p_entry_price,p_leverage,p_margin_used,p_entry_fee,p_liquidation_price,p_stop_loss,p_take_profit,p_signal_key,p_opened_at);
  insert into public.strategy_automation_executions(strategy_id,owner_user_id,paper_account_id,mode,symbol,side,quantity,price,fee,signal_key,executed_at,safe_metadata)
  values(p_strategy_id,p_owner_user_id,p_paper_account_id,'PAPER',p_symbol,case when p_side='LONG' then 'BUY' else 'SELL' end,p_quantity,p_entry_price,p_entry_fee,p_signal_key,p_opened_at,jsonb_build_object('adapter','PAPER','leverage',p_leverage));
  update public.strategy_paper_accounts set
    demo_equity=greatest(0,demo_equity-p_entry_fee),available_balance=greatest(0,available_balance-p_margin_used-p_entry_fee),
    used_strategy_capital=used_strategy_capital+p_margin_used,fees=fees+p_entry_fee,unrealized_pnl=0,state_version=state_version+1
  where id=p_paper_account_id;
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'PAPER_ORDER_FILLED','A deterministic paper entry was filled.',jsonb_build_object('signalKey',p_signal_key,'symbol',p_symbol,'side',p_side,'quantity',p_quantity,'leverage',p_leverage));
  return true;
end;
$$;

create or replace function public.black_core_paper_mark_position(
  p_position_id uuid,
  p_owner_user_id uuid,
  p_mark_price numeric,
  p_unrealized_pnl numeric
)
returns boolean language plpgsql security definer set search_path=public as $$
declare position_row public.strategy_paper_positions;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into position_row from public.strategy_paper_positions where id=p_position_id and owner_user_id=p_owner_user_id and closed_at is null for update;
  if position_row.id is null then return false; end if;
  update public.strategy_paper_positions set mark_price=p_mark_price,unrealized_pnl=p_unrealized_pnl,updated_at=now() where id=p_position_id;
  update public.strategy_paper_accounts set unrealized_pnl=(
    select coalesce(sum(unrealized_pnl),0) from public.strategy_paper_positions
    where paper_account_id=position_row.paper_account_id and closed_at is null
  ),state_version=state_version+1 where id=position_row.paper_account_id;
  return true;
end;
$$;

create or replace function public.black_core_paper_close_position(
  p_position_id uuid,
  p_owner_user_id uuid,
  p_exit_price numeric,
  p_exit_fee numeric,
  p_funding numeric,
  p_exit_reason text,
  p_exit_signal_key text,
  p_closed_at timestamptz
)
returns boolean language plpgsql security definer set search_path=public as $$
declare
  position_row public.strategy_paper_positions;
  paper public.strategy_paper_accounts;
  gross numeric;
  net numeric;
  next_equity numeric;
  next_peak numeric;
  next_drawdown numeric;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into position_row from public.strategy_paper_positions where id=p_position_id and owner_user_id=p_owner_user_id for update;
  if position_row.id is null or position_row.closed_at is not null then return false; end if;
  select * into paper from public.strategy_paper_accounts where id=position_row.paper_account_id for update;
  gross := (p_exit_price-position_row.entry_price)*position_row.quantity*case when position_row.side='LONG' then 1 else -1 end;
  net := gross-position_row.entry_fee-p_exit_fee-p_funding;
  next_equity := greatest(0,paper.demo_equity+gross-p_exit_fee-p_funding);
  next_peak := greatest(paper.peak_equity,next_equity);
  next_drawdown := case when next_peak>0 then greatest(paper.maximum_drawdown_percent,(next_peak-next_equity)/next_peak*100) else paper.maximum_drawdown_percent end;
  update public.strategy_paper_positions set mark_price=p_exit_price,unrealized_pnl=0,closed_at=p_closed_at,updated_at=now() where id=position_row.id;
  insert into public.strategy_automation_executions(strategy_id,owner_user_id,paper_account_id,mode,symbol,side,quantity,price,fee,funding,realized_pnl,signal_key,executed_at,safe_metadata)
  values(position_row.strategy_id,p_owner_user_id,position_row.paper_account_id,'PAPER',position_row.symbol,case when position_row.side='LONG' then 'SELL' else 'BUY' end,position_row.quantity,p_exit_price,p_exit_fee,p_funding,net,p_exit_signal_key,p_closed_at,jsonb_build_object('adapter','PAPER','exitReason',p_exit_reason));
  insert into public.strategy_automation_trades(strategy_id,owner_user_id,paper_account_id,mode,symbol,side,quantity,entry_price,exit_price,gross_pnl,fees,funding,net_pnl,entry_signal_key,exit_reason,opened_at,closed_at)
  values(position_row.strategy_id,p_owner_user_id,position_row.paper_account_id,'PAPER',position_row.symbol,position_row.side,position_row.quantity,position_row.entry_price,p_exit_price,gross,position_row.entry_fee+p_exit_fee,p_funding,net,position_row.signal_key,p_exit_reason,position_row.opened_at,p_closed_at);
  update public.strategy_paper_accounts set
    demo_equity=next_equity,available_balance=greatest(0,available_balance+position_row.margin_used+gross-p_exit_fee-p_funding),
    used_strategy_capital=greatest(0,used_strategy_capital-position_row.margin_used),realized_pnl=realized_pnl+net,
    unrealized_pnl=(select coalesce(sum(unrealized_pnl),0) from public.strategy_paper_positions where paper_account_id=position_row.paper_account_id and closed_at is null),
    fees=fees+p_exit_fee,funding=funding+p_funding,peak_equity=next_peak,maximum_drawdown_percent=next_drawdown,state_version=state_version+1
  where id=position_row.paper_account_id;
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,position_row.strategy_id,'PAPER_POSITION_CLOSED','A deterministic paper position was closed.',jsonb_build_object('entrySignalKey',position_row.signal_key,'exitSignalKey',p_exit_signal_key,'symbol',position_row.symbol,'reason',p_exit_reason,'netPnl',net));
  return true;
end;
$$;

create or replace function public.black_core_update_strategy_target_policy(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_binding_id uuid,
  p_expected_row_version integer,
  p_policy jsonb,
  p_canonical_hash text,
  p_risk_increased boolean,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  binding public.strategy_target_bindings;
  prior_request public.strategy_target_mutation_requests;
  next_policy_version integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_target_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.binding_id<>p_binding_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',p_binding_id,'rowVersion',prior_request.row_version,'status',prior_request.target_status,'idempotent',true);
  end if;
  select * into binding from public.strategy_target_bindings where id=p_binding_id and strategy_id=p_strategy_id
    and owner_user_id=p_owner_user_id and status<>'DISCONNECTED' for update;
  if binding.id is null then raise exception 'strategy target ownership mismatch' using errcode='42501'; end if;
  if binding.row_version<>p_expected_row_version then raise exception 'strategy target version conflict' using errcode='40001'; end if;
  next_policy_version := binding.capital_policy_version+1;
  update public.strategy_target_bindings set
    strategy_allocation_mode=p_policy->>'strategyAllocationMode',strategy_allocation_value=(p_policy->>'strategyAllocationValue')::numeric,
    trade_amount_mode=p_policy->>'tradeAmountMode',trade_amount_value=(p_policy->>'tradeAmountValue')::numeric,
    requested_leverage=nullif(p_policy->>'requestedLeverage','')::numeric,maximum_leverage=nullif(p_policy->>'maximumLeverage','')::numeric,
    maximum_position_percent=(p_policy->>'maximumPositionPercent')::numeric,maximum_exposure_percent=(p_policy->>'maximumExposurePercent')::numeric,
    maximum_daily_loss=(p_policy->>'maximumDailyLoss')::numeric,maximum_drawdown=(p_policy->>'maximumDrawdown')::numeric,
    maximum_positions=(p_policy->>'maximumPositions')::integer,slippage_bps=(p_policy->>'slippageBps')::numeric,
    margin_mode=nullif(p_policy->>'marginMode',''),quote_asset_reserve_percent=nullif(p_policy->>'quoteAssetReservePercent','')::numeric,
    maximum_base_asset_exposure_percent=nullif(p_policy->>'maximumBaseAssetExposurePercent','')::numeric,
    capital_policy_version=next_policy_version,row_version=row_version+1,
    validation_snapshot=case when p_risk_increased then validation_snapshot||jsonb_build_object('revalidationRequired',true,'validatedAt',null) else validation_snapshot end,
    status=case when p_risk_increased then 'READY' else status end,
    armed_at=case when p_risk_increased then null else armed_at end
  where id=p_binding_id;
  insert into public.strategy_target_policy_versions(binding_id,strategy_id,owner_user_id,version,policy_snapshot,canonical_hash,change_kind)
  values(p_binding_id,p_strategy_id,p_owner_user_id,next_policy_version,p_policy,p_canonical_hash,case when p_risk_increased then 'RISK_INCREASED' else 'RISK_REDUCED' end);
  insert into public.strategy_target_mutation_requests(owner_user_id,strategy_id,binding_id,idempotency_key,request_hash,row_version,target_status)
  values(p_owner_user_id,p_strategy_id,p_binding_id,p_idempotency_key,p_request_hash,p_expected_row_version+1,case when p_risk_increased then 'READY' else binding.status end);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,p_binding_id,'STRATEGY_TARGET_CAPITAL_POLICY_CHANGED','A target capital and risk policy was atomically versioned.',
    jsonb_build_object('version',next_policy_version,'riskIncrease',p_risk_increased));
  return jsonb_build_object('bindingId',p_binding_id,'rowVersion',p_expected_row_version+1,'idempotent',false);
end;
$$;

create or replace function public.black_core_control_strategy_target(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_binding_id uuid,
  p_expected_row_version integer,
  p_action text,
  p_validation_snapshot jsonb,
  p_disconnect_policy text,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  binding public.strategy_target_bindings;
  prior_request public.strategy_target_mutation_requests;
  next_status text;
  event_name text;
  now_at timestamptz := now();
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_target_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.binding_id<>p_binding_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('bindingId',p_binding_id,'rowVersion',prior_request.row_version,'status',prior_request.target_status,'idempotent',true);
  end if;
  select * into binding from public.strategy_target_bindings where id=p_binding_id and strategy_id=p_strategy_id
    and owner_user_id=p_owner_user_id for update;
  if binding.id is null then raise exception 'strategy target ownership mismatch' using errcode='42501'; end if;
  if binding.row_version<>p_expected_row_version then raise exception 'strategy target version conflict' using errcode='40001'; end if;
  if p_action='PAUSE' then
    if binding.status not in ('READY','LIVE','DEGRADED','RISK_SUSPENDED') then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    next_status := 'PAUSED';
    event_name := 'STRATEGY_TARGET_PAUSED';
    update public.strategy_target_bindings set status=next_status,paused_at=now_at,row_version=row_version+1 where id=binding.id;
  elsif p_action='RESUME' then
    if binding.status<>'PAUSED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if coalesce((p_validation_snapshot->>'eligible')::boolean,false) is not true then raise exception 'strategy target validation failed' using errcode='55000'; end if;
    next_status := 'READY';
    event_name := 'STRATEGY_TARGET_RESUMED';
    update public.strategy_target_bindings set status=next_status,paused_at=null,validation_snapshot=p_validation_snapshot,row_version=row_version+1 where id=binding.id;
  elsif p_action='DISCONNECT' then
    if binding.status='DISCONNECTED' then raise exception 'strategy target state conflict' using errcode='55000'; end if;
    if p_disconnect_policy not in ('DETACH_MANUAL','CLOSE_STRATEGY_POSITIONS','KEEP_PROTECTED','DISCONNECT_WHEN_FLAT') then raise exception 'invalid disconnect policy' using errcode='22023'; end if;
    next_status := 'DISCONNECTED';
    event_name := 'STRATEGY_TARGET_DISCONNECTED';
    update public.strategy_target_bindings set status=next_status,disconnected_at=now_at,disconnect_policy=p_disconnect_policy,row_version=row_version+1 where id=binding.id;
  else raise exception 'invalid strategy target action' using errcode='22023';
  end if;
  insert into public.strategy_target_mutation_requests(owner_user_id,strategy_id,binding_id,idempotency_key,request_hash,row_version,target_status)
  values(p_owner_user_id,p_strategy_id,p_binding_id,p_idempotency_key,p_request_hash,p_expected_row_version+1,next_status);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,binding_id,event_type,severity,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,p_binding_id,event_name,case when p_action='DISCONNECT' then 'WARNING' else 'INFO' end,
    case when p_action='DISCONNECT' then 'A target binding was revoked and its slot was returned to empty.' else 'A strategy target lifecycle action was applied atomically.' end,
    jsonb_build_object('action',p_action,'slotIndex',binding.slot_index,'status',next_status,'disconnectPolicy',p_disconnect_policy,'historicalRecordsPreserved',true));
  return jsonb_build_object('bindingId',p_binding_id,'rowVersion',p_expected_row_version+1,'status',next_status,'idempotent',false);
end;
$$;

create or replace function public.black_core_reorder_strategy_targets(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_strategy_version integer,
  p_assignments jsonb,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  strategy_row public.strategy_automation_strategies;
  prior_request public.strategy_target_reorder_requests;
  prior_statuses jsonb;
  assignment jsonb;
  assignment_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  if jsonb_typeof(p_assignments)<>'array' then raise exception 'invalid target reorder assignments' using errcode='22023'; end if;
  assignment_count := jsonb_array_length(p_assignments);
  if assignment_count not between 1 and 10 then raise exception 'invalid target reorder assignments' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy-target:'||p_strategy_id::text,0));
  select * into strategy_row from public.strategy_automation_strategies where id=p_strategy_id and owner_user_id=p_owner_user_id and archived_at is null for update;
  if strategy_row.id is null then raise exception 'strategy ownership mismatch' using errcode='42501'; end if;
  if strategy_row.current_version<>p_strategy_version then raise exception 'strategy version conflict' using errcode='40001'; end if;
  select * into prior_request from public.strategy_target_reorder_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.strategy_id<>p_strategy_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('assignments',prior_request.result_snapshot,'idempotent',true);
  end if;
  if (select count(distinct item->>'bindingId') from jsonb_array_elements(p_assignments) item)<>assignment_count
    or (select count(distinct (item->>'slotIndex')::integer) from jsonb_array_elements(p_assignments) item)<>assignment_count
    or exists(select 1 from jsonb_array_elements(p_assignments) item where (item->>'slotIndex')::integer not between 1 and 10) then
    raise exception 'duplicate or invalid target reorder assignment' using errcode='22023';
  end if;
  if (select count(*) from public.strategy_target_bindings b join jsonb_array_elements(p_assignments) item on b.id=(item->>'bindingId')::uuid
      where b.strategy_id=p_strategy_id and b.strategy_version=p_strategy_version and b.owner_user_id=p_owner_user_id and b.status<>'DISCONNECTED'
        and b.row_version=(item->>'expectedVersion')::integer)<>assignment_count then
    raise exception 'strategy target version conflict' using errcode='40001';
  end if;
  if exists(
    select 1 from public.strategy_target_bindings b
    where b.strategy_id=p_strategy_id and b.strategy_version=p_strategy_version and b.status<>'DISCONNECTED'
      and b.slot_index in (select (item->>'slotIndex')::integer from jsonb_array_elements(p_assignments) item)
      and b.id not in (select (item->>'bindingId')::uuid from jsonb_array_elements(p_assignments) item)
  ) then raise exception 'target reorder slot is occupied' using errcode='23505'; end if;
  select jsonb_object_agg(b.id::text,b.status) into prior_statuses from public.strategy_target_bindings b
    where b.id in (select (item->>'bindingId')::uuid from jsonb_array_elements(p_assignments) item);
  update public.strategy_target_bindings set status='DISCONNECTED'
    where id in (select (item->>'bindingId')::uuid from jsonb_array_elements(p_assignments) item);
  for assignment in select * from jsonb_array_elements(p_assignments) loop
    update public.strategy_target_bindings set
      slot_index=(assignment->>'slotIndex')::integer,
      status=prior_statuses->>(assignment->>'bindingId'),
      row_version=row_version+1
    where id=(assignment->>'bindingId')::uuid;
  end loop;
  insert into public.strategy_target_reorder_requests(owner_user_id,strategy_id,strategy_version,idempotency_key,request_hash,result_snapshot)
  values(p_owner_user_id,p_strategy_id,p_strategy_version,p_idempotency_key,p_request_hash,p_assignments);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'STRATEGY_TARGET_SLOTS_REORDERED','Live target display slots were reordered without changing target identities or runtime state.',
    jsonb_build_object('assignmentCount',assignment_count));
  return jsonb_build_object('assignments',p_assignments,'idempotent',false);
end;
$$;

create or replace function public.black_core_configure_paper_policy(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_paper_account_id uuid,
  p_expected_state_version bigint,
  p_policy jsonb,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  paper public.strategy_paper_accounts;
  prior_request public.strategy_paper_mutation_requests;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_paper_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.paper_account_id<>p_paper_account_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('paperAccountId',p_paper_account_id,'stateVersion',prior_request.state_version,'idempotent',true);
  end if;
  select * into paper from public.strategy_paper_accounts where id=p_paper_account_id and strategy_id=p_strategy_id and owner_user_id=p_owner_user_id for update;
  if paper.id is null then raise exception 'paper target ownership mismatch' using errcode='42501'; end if;
  if paper.state_version<>p_expected_state_version then raise exception 'paper target version conflict' using errcode='40001'; end if;
  update public.strategy_paper_accounts set capital_policy=p_policy,capital_policy_version=capital_policy_version+1,state_version=state_version+1 where id=paper.id;
  insert into public.strategy_paper_mutation_requests(owner_user_id,strategy_id,paper_account_id,idempotency_key,request_hash,state_version)
  values(p_owner_user_id,p_strategy_id,p_paper_account_id,p_idempotency_key,p_request_hash,paper.state_version+1);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,'PAPER_CAPITAL_POLICY_CHANGED','The paper target capital policy was atomically updated.',jsonb_build_object('version',paper.capital_policy_version+1));
  return jsonb_build_object('paperAccountId',paper.id,'stateVersion',paper.state_version+1,'idempotent',false);
end;
$$;

create or replace function public.black_core_control_paper_target(
  p_owner_user_id uuid,
  p_strategy_id uuid,
  p_paper_account_id uuid,
  p_expected_state_version bigint,
  p_action text,
  p_amount numeric,
  p_request_hash text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  paper public.strategy_paper_accounts;
  prior_request public.strategy_paper_mutation_requests;
  next_status text;
  next_equity numeric;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  select * into prior_request from public.strategy_paper_mutation_requests where owner_user_id=p_owner_user_id and idempotency_key=p_idempotency_key;
  if prior_request.id is not null then
    if prior_request.paper_account_id<>p_paper_account_id or prior_request.request_hash<>p_request_hash then raise exception 'idempotency key payload mismatch' using errcode='22023'; end if;
    return jsonb_build_object('paperAccountId',p_paper_account_id,'stateVersion',prior_request.state_version,'idempotent',true);
  end if;
  select * into paper from public.strategy_paper_accounts where id=p_paper_account_id and strategy_id=p_strategy_id and owner_user_id=p_owner_user_id for update;
  if paper.id is null then raise exception 'paper target ownership mismatch' using errcode='42501'; end if;
  if paper.state_version<>p_expected_state_version then raise exception 'paper target version conflict' using errcode='40001'; end if;
  if p_action in ('START','PAUSE') then
    next_status := case when p_action='START' then 'ACTIVE' else 'PAUSED' end;
    update public.strategy_paper_accounts set status=next_status,state_version=state_version+1 where id=paper.id;
    update public.strategy_automation_strategies set status=case when next_status='ACTIVE' then 'PAPER_ACTIVE' else 'PAPER_PAUSED' end
      where id=p_strategy_id and owner_user_id=p_owner_user_id;
  elsif p_action='TOP_UP' then
    if p_amount is null or p_amount<=0 or p_amount>1000000000 then raise exception 'invalid paper top up' using errcode='22023'; end if;
    next_equity := paper.demo_equity+p_amount;
    update public.strategy_paper_accounts set demo_equity=next_equity,available_balance=available_balance+p_amount,
      peak_equity=greatest(peak_equity,next_equity),state_version=state_version+1 where id=paper.id;
  elsif p_action='RESET' then
    if exists(select 1 from public.strategy_paper_positions where paper_account_id=paper.id and closed_at is null) then
      raise exception 'paper target has an open position' using errcode='55000';
    end if;
    next_equity := coalesce(p_amount,10000);
    if next_equity<=0 or next_equity>1000000000 then raise exception 'invalid paper equity' using errcode='22023'; end if;
    update public.strategy_paper_accounts set demo_equity=next_equity,available_balance=next_equity,used_strategy_capital=0,
      realized_pnl=0,unrealized_pnl=0,fees=0,funding=0,peak_equity=next_equity,maximum_drawdown_percent=0,status='PAUSED',state_version=state_version+1 where id=paper.id;
  else raise exception 'invalid paper action' using errcode='22023';
  end if;
  insert into public.strategy_paper_mutation_requests(owner_user_id,strategy_id,paper_account_id,idempotency_key,request_hash,state_version)
  values(p_owner_user_id,p_strategy_id,p_paper_account_id,p_idempotency_key,p_request_hash,paper.state_version+1);
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,p_strategy_id,
    case p_action when 'START' then 'PAPER_TARGET_STARTED' when 'PAUSE' then 'PAPER_TARGET_PAUSED' when 'TOP_UP' then 'PAPER_EQUITY_TOPPED_UP' else 'PAPER_ACCOUNT_RESET' end,
    'A paper target control action was applied atomically.',jsonb_build_object('action',p_action,'amount',p_amount));
  return jsonb_build_object('paperAccountId',paper.id,'stateVersion',paper.state_version+1,'idempotent',false);
end;
$$;

alter table public.execution_orders add column if not exists strategy_automation_id uuid references public.strategy_automation_strategies(id) on delete set null;
alter table public.execution_orders add column if not exists strategy_target_binding_id uuid references public.strategy_target_bindings(id) on delete set null;
alter table public.execution_fills add column if not exists strategy_automation_id uuid references public.strategy_automation_strategies(id) on delete set null;
alter table public.execution_fills add column if not exists strategy_target_binding_id uuid references public.strategy_target_bindings(id) on delete set null;
alter table public.account_positions add column if not exists strategy_automation_id uuid references public.strategy_automation_strategies(id) on delete set null;
alter table public.account_positions add column if not exists strategy_target_binding_id uuid references public.strategy_target_bindings(id) on delete set null;
alter table public.group_trade_intents add column if not exists strategy_automation_id uuid references public.strategy_automation_strategies(id) on delete set null;
alter table public.group_trade_intents add column if not exists strategy_target_binding_id uuid references public.strategy_target_bindings(id) on delete set null;
create index if not exists idx_execution_orders_strategy_target on public.execution_orders(strategy_target_binding_id,created_at desc) where strategy_target_binding_id is not null;
create index if not exists idx_execution_fills_strategy_target on public.execution_fills(strategy_target_binding_id,filled_at desc) where strategy_target_binding_id is not null;
create index if not exists idx_account_positions_strategy_target on public.account_positions(strategy_target_binding_id,updated_at desc) where strategy_target_binding_id is not null;
create index if not exists idx_group_trade_intents_strategy_target on public.group_trade_intents(strategy_target_binding_id,created_at desc) where strategy_target_binding_id is not null;

create or replace function public.black_core_strategy_set_updated_at()
returns trigger language plpgsql set search_path=public as $$ begin new.updated_at=now(); return new; end $$;
create or replace function public.black_core_strategy_prevent_immutable_change()
returns trigger language plpgsql set search_path=public as $$ begin raise exception 'immutable strategy automation ledger rows cannot be changed'; end $$;

drop trigger if exists trg_strategy_automation_updated_at on public.strategy_automation_strategies;
create trigger trg_strategy_automation_updated_at before update on public.strategy_automation_strategies for each row execute function public.black_core_strategy_set_updated_at();
drop trigger if exists trg_strategy_paper_accounts_updated_at on public.strategy_paper_accounts;
create trigger trg_strategy_paper_accounts_updated_at before update on public.strategy_paper_accounts for each row execute function public.black_core_strategy_set_updated_at();
drop trigger if exists trg_strategy_target_bindings_updated_at on public.strategy_target_bindings;
create trigger trg_strategy_target_bindings_updated_at before update on public.strategy_target_bindings for each row execute function public.black_core_strategy_set_updated_at();
drop trigger if exists trg_strategy_runtime_updated_at on public.strategy_automation_runtime_state;
create trigger trg_strategy_runtime_updated_at before update on public.strategy_automation_runtime_state for each row execute function public.black_core_strategy_set_updated_at();
drop trigger if exists trg_strategy_versions_immutable on public.strategy_automation_versions;
create trigger trg_strategy_versions_immutable before update or delete on public.strategy_automation_versions for each row execute function public.black_core_strategy_prevent_immutable_change();
drop trigger if exists trg_strategy_policy_versions_immutable on public.strategy_target_policy_versions;
create trigger trg_strategy_policy_versions_immutable before update or delete on public.strategy_target_policy_versions for each row execute function public.black_core_strategy_prevent_immutable_change();
drop trigger if exists trg_strategy_audit_immutable on public.strategy_automation_audit_events;
create trigger trg_strategy_audit_immutable before update or delete on public.strategy_automation_audit_events for each row execute function public.black_core_strategy_prevent_immutable_change();

alter table public.strategy_automation_strategies enable row level security;
alter table public.strategy_automation_save_requests enable row level security;
alter table public.strategy_automation_versions enable row level security;
alter table public.strategy_paper_accounts enable row level security;
alter table public.strategy_paper_mutation_requests enable row level security;
alter table public.strategy_target_mutation_requests enable row level security;
alter table public.strategy_target_reorder_requests enable row level security;
alter table public.strategy_target_bindings enable row level security;
alter table public.strategy_target_policy_versions enable row level security;
alter table public.strategy_target_snapshots enable row level security;
alter table public.strategy_paper_positions enable row level security;
alter table public.strategy_paper_orders enable row level security;
alter table public.strategy_automation_executions enable row level security;
alter table public.strategy_automation_trades enable row level security;
alter table public.strategy_automation_runtime_state enable row level security;
alter table public.strategy_automation_audit_events enable row level security;

revoke all on public.strategy_automation_strategies,public.strategy_automation_save_requests,public.strategy_automation_versions,public.strategy_paper_accounts,public.strategy_paper_mutation_requests,public.strategy_target_mutation_requests,public.strategy_target_reorder_requests,
  public.strategy_target_bindings,public.strategy_target_policy_versions,public.strategy_target_snapshots,
  public.strategy_paper_positions,public.strategy_paper_orders,public.strategy_automation_executions,
  public.strategy_automation_trades,public.strategy_automation_runtime_state,public.strategy_automation_audit_events
  from anon,authenticated;
revoke all on function public.black_core_create_strategy(uuid,text,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.black_core_save_strategy(uuid,uuid,text,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.black_core_add_strategy_target(uuid,uuid,integer,integer,text,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.black_core_create_strategy(uuid,text,jsonb,jsonb,jsonb,text,text) to service_role;
grant execute on function public.black_core_save_strategy(uuid,uuid,text,jsonb,jsonb,jsonb,text,text) to service_role;
grant execute on function public.black_core_add_strategy_target(uuid,uuid,integer,integer,text,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text,text) to service_role;
revoke all on function public.black_core_paper_open_position(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz) from public,anon,authenticated;
revoke all on function public.black_core_claim_strategy_runtime(uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.black_core_update_strategy_target_policy(uuid,uuid,uuid,integer,jsonb,text,boolean,text,text) from public,anon,authenticated;
revoke all on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) from public,anon,authenticated;
revoke all on function public.black_core_reorder_strategy_targets(uuid,uuid,integer,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.black_core_configure_paper_policy(uuid,uuid,uuid,bigint,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.black_core_control_paper_target(uuid,uuid,uuid,bigint,text,numeric,text,text) from public,anon,authenticated;
revoke all on function public.black_core_paper_mark_position(uuid,uuid,numeric,numeric) from public,anon,authenticated;
revoke all on function public.black_core_paper_close_position(uuid,uuid,numeric,numeric,numeric,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.black_core_paper_open_position(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz) to service_role;
grant execute on function public.black_core_claim_strategy_runtime(uuid,uuid,text,integer) to service_role;
grant execute on function public.black_core_update_strategy_target_policy(uuid,uuid,uuid,integer,jsonb,text,boolean,text,text) to service_role;
grant execute on function public.black_core_control_strategy_target(uuid,uuid,uuid,integer,text,jsonb,text,text,text) to service_role;
grant execute on function public.black_core_reorder_strategy_targets(uuid,uuid,integer,jsonb,text,text) to service_role;
grant execute on function public.black_core_configure_paper_policy(uuid,uuid,uuid,bigint,jsonb,text,text) to service_role;
grant execute on function public.black_core_control_paper_target(uuid,uuid,uuid,bigint,text,numeric,text,text) to service_role;
grant execute on function public.black_core_paper_mark_position(uuid,uuid,numeric,numeric) to service_role;
grant execute on function public.black_core_paper_close_position(uuid,uuid,numeric,numeric,numeric,text,text,timestamptz) to service_role;

comment on table public.strategy_target_bindings is 'Only occupied live target slots are stored. Empty slots 1-10 are derived UI state.';
comment on table public.strategy_paper_accounts is 'Separate virtual target; never merged with live target performance.';
comment on column public.strategy_target_bindings.strategy_allocation_value is 'Percentage when strategy_allocation_mode=PERCENT_ACCOUNT_EQUITY; never a statistical percentile.';

commit;
