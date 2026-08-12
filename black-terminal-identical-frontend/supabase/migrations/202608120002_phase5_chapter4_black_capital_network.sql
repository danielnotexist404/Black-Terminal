-- BLACK TERMINAL(TM) - Phase V, Chapter IV: Black Capital Network
-- Extends the canonical Professional Network, OMS/EMS, PositionManager and
-- Black Cloud foundations. Copy Trading is revocable; Obsidian is research-only.

begin;

create extension if not exists pgcrypto;

alter table public.investment_groups
  add column if not exists strategy_summary text not null default '',
  add column if not exists methodology_summary text not null default '',
  add column if not exists performance_source text,
  add column if not exists performance_period_start timestamptz,
  add column if not exists performance_period_end timestamptz,
  add column if not exists risk_classification text not null default 'UNCLASSIFIED',
  add column if not exists supported_participation_methods jsonb not null default '["COPY_TRADING","OBSIDIAN_VAULT"]'::jsonb,
  add column if not exists supported_providers jsonb not null default '["bybit"]'::jsonb,
  add column if not exists copy_trading_enabled boolean not null default true,
  add column if not exists obsidian_research_enabled boolean not null default true,
  add column if not exists group_max_leverage numeric not null default 20,
  add column if not exists emergency_stop boolean not null default false,
  add column if not exists emergency_stopped_at timestamptz;

alter table public.group_trade_intents
  add column if not exists strategy_parameters jsonb not null default '{}'::jsonb,
  add column if not exists maximum_slippage_bps integer;

alter table public.group_trade_intents
  drop constraint if exists group_trade_intents_strategy_parameters_object,
  add constraint group_trade_intents_strategy_parameters_object check (jsonb_typeof(strategy_parameters)='object'),
  drop constraint if exists group_trade_intents_maximum_slippage_bps_check,
  add constraint group_trade_intents_maximum_slippage_bps_check check (maximum_slippage_bps is null or maximum_slippage_bps between 0 and 10000);

alter table public.execution_orders
  add column if not exists reference_price numeric,
  add column if not exists actual_slippage_bps numeric,
  add column if not exists slippage_limit_bps integer,
  add column if not exists effective_leverage numeric;

alter table public.investment_groups
  drop constraint if exists investment_groups_supported_participation_methods_array,
  add constraint investment_groups_supported_participation_methods_array check (jsonb_typeof(supported_participation_methods) = 'array'),
  drop constraint if exists investment_groups_supported_providers_array,
  add constraint investment_groups_supported_providers_array check (jsonb_typeof(supported_providers) = 'array'),
  drop constraint if exists investment_groups_group_max_leverage_check,
  add constraint investment_groups_group_max_leverage_check check (group_max_leverage between 1 and 125),
  drop constraint if exists investment_groups_risk_classification_check,
  add constraint investment_groups_risk_classification_check check (risk_classification in ('UNCLASSIFIED','LOW','MODERATE','HIGH','VERY_HIGH'));

alter table public.investment_group_members
  add column if not exists participation_method text,
  add column if not exists membership_state text not null default 'ACTIVE',
  add column if not exists risk_acknowledgement_version text,
  add column if not exists mandate_id uuid,
  add column if not exists broker_connection_id uuid references public.connectivity_connections(id) on delete set null,
  add column if not exists portfolio_visibility text not null default 'GROUP_ONLY',
  add column if not exists idempotency_key text,
  add column if not exists state_version integer not null default 1,
  add column if not exists paused_at timestamptz,
  add column if not exists left_at timestamptz,
  add column if not exists removed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.investment_group_members
  drop constraint if exists investment_group_members_participation_method_check,
  add constraint investment_group_members_participation_method_check check (participation_method is null or participation_method in ('COPY_TRADING','OBSIDIAN_VAULT')),
  drop constraint if exists investment_group_members_membership_state_check,
  add constraint investment_group_members_membership_state_check check (membership_state in ('DRAFT','RISK_ACCEPTED','METHOD_SELECTED','CONFIGURING','PENDING_APPROVAL','APPROVED','ACTIVATING','ACTIVE','PAUSED_BY_USER','PAUSED_BY_MANAGER','RISK_SUSPENDED','LEAVING','LEFT','REMOVED','REJECTED','EXPIRED')),
  drop constraint if exists investment_group_members_portfolio_visibility_check,
  add constraint investment_group_members_portfolio_visibility_check check (portfolio_visibility in ('GROUP_ONLY','GROUP_AND_RISK_SUMMARY','FULL_SELECTED_ACCOUNT')),
  drop constraint if exists investment_group_members_state_version_check,
  add constraint investment_group_members_state_version_check check (state_version > 0);

create unique index if not exists idx_investment_group_members_idempotency
  on public.investment_group_members(user_id,idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_investment_group_members_operational
  on public.investment_group_members(group_id,membership_state,updated_at desc);

create table if not exists public.group_risk_disclosure_documents (
  version text primary key,
  locale text not null default 'en',
  title text not null,
  document_text text not null,
  mandatory_acknowledgements jsonb not null,
  document_hash text not null unique,
  material_change boolean not null default true,
  status text not null default 'ACTIVE' check (status in ('DRAFT','ACTIVE','SUPERSEDED')),
  effective_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (jsonb_typeof(mandatory_acknowledgements) = 'array')
);

insert into public.group_risk_disclosure_documents(version,locale,title,document_text,mandatory_acknowledgements,document_hash,material_change,status,effective_at)
values (
  '2026-08-12.v1',
  'en',
  'Investment and Copy-Trading Risk Acknowledgement',
  E'Trading digital assets, derivatives and leveraged products involves substantial risk. Profit is not guaranteed, and past performance does not predict future results. You may lose part or all of the capital allocated to this Investment Group.\n\nCopy Trading may produce different results between accounts because of market liquidity, slippage, latency, partial fills, broker limitations, minimum order sizes, connection failures, funding charges and exchange outages.\n\nThe Investment Group manager may submit permitted trading instructions through your signed Copy-Trading mandate. The manager cannot withdraw your funds, transfer assets or view your private API credentials.\n\nCopy Trading may remain active after you close Black Terminal, log out or turn off your computer. You may pause or leave Copy Trading at any time. Open positions and pending orders require an explicit exit treatment.\n\nParticipation is voluntary. You are responsible for selecting your allocation, leverage cap and risk limits, monitoring your account and deciding whether the Investment Group is appropriate for you.\n\nNothing in this interface constitutes a guarantee of return. This acknowledgement does not waive statutory rights or Black Terminal security and operational responsibilities. Final public wording requires qualified legal review before broad launch.',
  '["noProfitGuarantee","capitalLoss","leverageLiquidation","executionDivergence","persistentExecution","noWithdrawalAuthority","pauseOrLeaveAnytime"]'::jsonb,
  encode(digest(E'2026-08-12.v1|Investment and Copy-Trading Risk Acknowledgement|Trading digital assets, derivatives and leveraged products involves substantial risk. Profit is not guaranteed, and past performance does not predict future results. You may lose part or all of the capital allocated to this Investment Group.', 'sha256'), 'hex'),
  true,
  'ACTIVE',
  now()
)
on conflict (version) do update set
  document_text = excluded.document_text,
  mandatory_acknowledgements = excluded.mandatory_acknowledgements,
  document_hash = excluded.document_hash,
  material_change = excluded.material_change,
  status = excluded.status;

create table if not exists public.group_risk_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  participation_method text,
  disclosure_version text not null references public.group_risk_disclosure_documents(version) on delete restrict,
  document_hash text not null,
  locale text not null default 'en',
  acknowledgement_snapshot jsonb not null,
  application_version text,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id,group_id,disclosure_version),
  check (participation_method is null or participation_method in ('COPY_TRADING','OBSIDIAN_VAULT')),
  check (jsonb_typeof(acknowledgement_snapshot) = 'object')
);

create table if not exists public.investment_group_join_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  risk_acknowledgement_id uuid references public.group_risk_acknowledgements(id) on delete set null,
  current_step text not null default 'DRAFT' check (current_step in ('DRAFT','RISK_ACCEPTED','METHOD_SELECTED','CONFIGURING','REVIEW')),
  participation_method text check (participation_method is null or participation_method in ('COPY_TRADING','OBSIDIAN_VAULT')),
  safe_configuration jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,group_id),
  check (jsonb_typeof(safe_configuration) = 'object')
);

create table if not exists public.investment_group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  invited_by_user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check(status in ('pending','accepted','revoked','expired')),
  expires_at timestamptz not null default (now() + interval '30 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(group_id,recipient_user_id)
);

alter table public.investment_group_invites
  add column if not exists accepted_at timestamptz;

create table if not exists public.group_member_risk_policies (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null unique references public.investment_group_members(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  allocation_percent numeric not null check (allocation_percent > 0 and allocation_percent <= 100),
  user_maximum_leverage numeric not null check (user_maximum_leverage between 1 and 125),
  manager_requested_leverage numeric not null check (manager_requested_leverage between 1 and 125),
  effective_leverage numeric not null check (effective_leverage between 1 and 125),
  maximum_position_equity_percent numeric not null check (maximum_position_equity_percent > 0 and maximum_position_equity_percent <= 100),
  maximum_total_exposure_percent numeric not null check (maximum_total_exposure_percent > 0 and maximum_total_exposure_percent <= 500),
  maximum_daily_loss_percent numeric not null check (maximum_daily_loss_percent > 0 and maximum_daily_loss_percent <= 100),
  maximum_drawdown_percent numeric not null check (maximum_drawdown_percent > 0 and maximum_drawdown_percent <= 100),
  allowed_symbols jsonb not null,
  allowed_market_types jsonb not null,
  long_enabled boolean not null default true,
  short_enabled boolean not null default true,
  allowed_order_types jsonb not null,
  margin_mode text not null default 'CROSS' check (margin_mode in ('CROSS','ISOLATED')),
  maximum_slippage_bps integer not null check (maximum_slippage_bps between 0 and 10000),
  exit_policy text not null default 'DETACH' check (exit_policy in ('DETACH','CLOSE_NOW','WHEN_FLAT')),
  updated_by_user_id uuid not null references auth.users(id) on delete restrict,
  user_consented_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (manager_requested_leverage <= user_maximum_leverage),
  check (effective_leverage <= manager_requested_leverage),
  check (effective_leverage <= user_maximum_leverage),
  check (jsonb_typeof(allowed_symbols) = 'array'),
  check (jsonb_typeof(allowed_market_types) = 'array'),
  check (jsonb_typeof(allowed_order_types) = 'array')
);

create table if not exists public.group_member_risk_policy_versions (
  id uuid primary key default gen_random_uuid(),
  risk_policy_id uuid not null references public.group_member_risk_policies(id) on delete cascade,
  membership_id uuid not null references public.investment_group_members(id) on delete cascade,
  version integer not null check (version > 0),
  policy_snapshot jsonb not null,
  canonical_hash text not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  reason text not null,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  unique(risk_policy_id,version)
);

create table if not exists public.group_member_portfolio_visibility (
  membership_id uuid primary key references public.investment_group_members(id) on delete cascade,
  visibility text not null check (visibility in ('GROUP_ONLY','GROUP_AND_RISK_SUMMARY','FULL_SELECTED_ACCOUNT')),
  consented_by_user_id uuid not null references auth.users(id) on delete cascade,
  consented_at timestamptz not null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.group_member_status_history (
  id bigint generated always as identity primary key,
  membership_id uuid not null references public.investment_group_members(id) on delete cascade,
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  previous_state text,
  next_state text not null,
  reason text not null,
  correlation_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_member_portfolio_snapshots (
  membership_id uuid primary key references public.investment_group_members(id) on delete cascade,
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  connection_id uuid not null references public.connectivity_connections(id) on delete cascade,
  captured_at timestamptz not null,
  freshness text not null check (freshness in ('LIVE','STALE','DEGRADED')),
  equity numeric not null default 0,
  available_balance numeric not null default 0,
  allocated_equity numeric not null default 0,
  used_margin numeric not null default 0,
  margin_utilization_percent numeric not null default 0,
  gross_exposure numeric not null default 0,
  net_exposure numeric not null default 0,
  long_exposure numeric not null default 0,
  short_exposure numeric not null default 0,
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  gross_pnl numeric not null default 0,
  fees numeric not null default 0,
  funding numeric not null default 0,
  net_pnl numeric not null default 0,
  current_drawdown_percent numeric,
  maximum_drawdown_percent numeric,
  open_position_count integer not null default 0,
  open_order_count integer not null default 0,
  safe_metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.group_aggregate_snapshots (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  captured_at timestamptz not null,
  rollup_interval text not null default 'LATEST' check (rollup_interval in ('LATEST','1_MINUTE','1_HOUR','1_DAY')),
  active_members integer not null default 0,
  paused_members integer not null default 0,
  degraded_members integer not null default 0,
  connected_equity numeric not null default 0,
  allocated_equity numeric not null default 0,
  gross_exposure numeric not null default 0,
  net_exposure numeric not null default 0,
  long_exposure numeric not null default 0,
  short_exposure numeric not null default 0,
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  gross_pnl numeric not null default 0,
  fees numeric not null default 0,
  funding numeric not null default 0,
  net_pnl numeric not null default 0,
  current_drawdown_percent numeric,
  maximum_drawdown_percent numeric,
  weighted_leverage numeric not null default 0,
  margin_utilization_percent numeric not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_group_aggregate_latest on public.group_aggregate_snapshots(group_id) where rollup_interval='LATEST';
create index if not exists idx_group_aggregate_history on public.group_aggregate_snapshots(group_id,rollup_interval,captured_at desc);

create table if not exists public.group_member_exit_requests (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.investment_group_members(id) on delete restrict,
  group_id uuid not null references public.investment_groups(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  exit_policy text not null check (exit_policy in ('DETACH','CLOSE_NOW','WHEN_FLAT')),
  idempotency_key text not null,
  future_entry_revoked_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id,idempotency_key)
);

create table if not exists public.group_removal_events (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.investment_group_members(id) on delete restrict,
  group_id uuid not null references public.investment_groups(id) on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  reason text not null check (char_length(trim(reason)) between 5 and 500),
  future_entry_revoked_at timestamptz not null,
  positions_detached boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.obsidian_waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.investment_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  research_consent boolean not null default true,
  created_at timestamptz not null default now(),
  unique(group_id,user_id)
);

alter table public.group_execution_mandates
  add column if not exists membership_id uuid references public.investment_group_members(id) on delete restrict,
  add column if not exists broker_account_id uuid references public.exchange_accounts(id) on delete restrict,
  add column if not exists manager_requested_leverage numeric,
  add column if not exists effective_leverage numeric,
  add column if not exists maximum_position_equity_percent numeric,
  add column if not exists maximum_total_exposure_percent numeric,
  add column if not exists maximum_daily_loss_percent numeric,
  add column if not exists maximum_drawdown_percent numeric,
  add column if not exists allowed_directions jsonb not null default '["LONG","SHORT"]'::jsonb,
  add column if not exists margin_mode text,
  add column if not exists exit_policy text not null default 'DETACH',
  add column if not exists portfolio_visibility text not null default 'GROUP_ONLY';

alter table public.group_execution_mandates
  drop constraint if exists group_execution_mandates_status_check,
  add constraint group_execution_mandates_status_check check (status in ('PENDING_CONSENT','ACTIVE','PAUSED','EXIT_ONLY','EXPIRED','REVOKED')),
  drop constraint if exists group_execution_mandates_allowed_directions_array,
  add constraint group_execution_mandates_allowed_directions_array check (jsonb_typeof(allowed_directions)='array'),
  drop constraint if exists group_execution_mandates_exit_policy_check,
  add constraint group_execution_mandates_exit_policy_check check (exit_policy in ('DETACH','CLOSE_NOW','WHEN_FLAT')),
  drop constraint if exists group_execution_mandates_portfolio_visibility_check,
  add constraint group_execution_mandates_portfolio_visibility_check check (portfolio_visibility in ('GROUP_ONLY','GROUP_AND_RISK_SUMMARY','FULL_SELECTED_ACCOUNT'));

create unique index if not exists idx_group_execution_one_account_authority
  on public.group_execution_mandates(broker_connection_id)
  where status in ('ACTIVE','PAUSED','EXIT_ONLY');

do $$
begin
  if exists(
    select 1 from public.group_execution_mandates m
    join public.connectivity_connections c on c.id=m.broker_connection_id
    where m.status in ('ACTIVE','PAUSED') and c.account_id is not null
    group by c.account_id
    having count(distinct m.group_id) > 1
  ) then
    raise exception 'Black Capital migration blocked: one broker account has active mandates for multiple groups' using errcode='23505';
  end if;
  update public.group_execution_mandates m
  set broker_account_id=c.account_id
  from public.connectivity_connections c
  where c.id=m.broker_connection_id and m.broker_account_id is null and c.account_id is not null;
end;
$$;

create unique index if not exists idx_group_execution_one_broker_account_authority
  on public.group_execution_mandates(broker_account_id)
  where broker_account_id is not null and status in ('ACTIVE','PAUSED','EXIT_ONLY');

alter table public.investment_group_members
  drop constraint if exists investment_group_members_mandate_id_fkey,
  add constraint investment_group_members_mandate_id_fkey foreign key (mandate_id) references public.group_execution_mandates(id) on delete set null;

alter table public.position_lifecycle_positions
  add column if not exists origin text not null default 'MANUAL_BLACK_TERMINAL',
  add column if not exists group_id uuid references public.investment_groups(id) on delete set null,
  add column if not exists membership_id uuid references public.investment_group_members(id) on delete set null,
  add column if not exists mandate_id uuid references public.group_execution_mandates(id) on delete set null,
  add column if not exists fees numeric not null default 0,
  add column if not exists funding numeric not null default 0;

alter table public.position_lifecycle_positions
  drop constraint if exists position_lifecycle_positions_origin_check,
  add constraint position_lifecycle_positions_origin_check check (origin in ('MANUAL_BLACK_TERMINAL','INVESTMENT_GROUP','EXTERNAL_VENUE','PROTECTIVE'));
create index if not exists idx_position_lifecycle_group on public.position_lifecycle_positions(group_id,membership_id,lifecycle_state,updated_at desc) where group_id is not null;

create or replace function public.black_capital_set_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin
  new.updated_at = now();
  if tg_table_name = 'investment_group_members' and to_jsonb(old) is distinct from to_jsonb(new) then
    new.state_version = old.state_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_black_capital_members_updated_at on public.investment_group_members;
create trigger trg_black_capital_members_updated_at before update on public.investment_group_members for each row execute function public.black_capital_set_updated_at();
drop trigger if exists trg_black_capital_join_drafts_updated_at on public.investment_group_join_drafts;
create trigger trg_black_capital_join_drafts_updated_at before update on public.investment_group_join_drafts for each row execute function public.black_capital_set_updated_at();
drop trigger if exists trg_black_capital_invites_updated_at on public.investment_group_invites;
create trigger trg_black_capital_invites_updated_at before update on public.investment_group_invites for each row execute function public.black_capital_set_updated_at();
drop trigger if exists trg_black_capital_risk_policies_updated_at on public.group_member_risk_policies;
create trigger trg_black_capital_risk_policies_updated_at before update on public.group_member_risk_policies for each row execute function public.black_capital_set_updated_at();

create or replace function public.investment_group_can_manage(p_group_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.investment_groups g where g.id=p_group_id and g.owner_user_id=auth.uid())
    or exists(select 1 from public.investment_group_members m where m.group_id=p_group_id and m.user_id=auth.uid() and m.role in ('owner','manager') and m.status='active' and m.membership_state in ('ACTIVE','PAUSED_BY_USER','PAUSED_BY_MANAGER'));
$$;

create or replace function public.leave_investment_group_copy_trading(
  p_user_id uuid,
  p_group_id uuid,
  p_exit_policy text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_member public.investment_group_members%rowtype;
  v_existing public.group_member_exit_requests%rowtype;
  v_now timestamptz := now();
  v_next_state text;
begin
  if p_exit_policy not in ('DETACH','CLOSE_NOW','WHEN_FLAT') then raise exception 'Unsupported exit policy' using errcode='22023'; end if;
  select * into v_existing from public.group_member_exit_requests where user_id=p_user_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('membershipId',v_existing.membership_id,'state',case when v_existing.completed_at is null then 'LEAVING' else 'LEFT' end,'futureEntryRevokedAt',v_existing.future_entry_revoked_at,'idempotent',true); end if;
  select * into v_member from public.investment_group_members where group_id=p_group_id and user_id=p_user_id for update;
  if not found or v_member.role in ('owner','manager') then raise exception 'Active member membership not found' using errcode='42501'; end if;
  v_next_state := case when p_exit_policy='WHEN_FLAT' then 'LEAVING' else 'LEFT' end;

  update public.group_execution_mandates
    set status=case when p_exit_policy='CLOSE_NOW' then 'EXIT_ONLY' else 'REVOKED' end,
        revoked_at=case when p_exit_policy='CLOSE_NOW' then revoked_at else v_now end,
        paused_at=v_now,
        exit_policy=p_exit_policy
    where group_id=p_group_id and follower_user_id=p_user_id and status in ('PENDING_CONSENT','ACTIVE','PAUSED','EXIT_ONLY');

  update public.execution_commands c set status='CANCELLED',completed_at=v_now,last_error_code='MEMBERSHIP_EXIT'
    where c.status in ('QUEUED','RETRY') and exists(
      select 1 from public.follower_execution_plans p join public.group_execution_mandates m on m.id=p.mandate_id
      where p.id=c.follower_plan_id and m.group_id=p_group_id and p.follower_user_id=p_user_id
    );
  update public.follower_execution_plans p set execution_status='CANCELLED',rejection_reason='Membership exit revoked future entry authority.',updated_at=v_now
    where p.follower_user_id=p_user_id and p.execution_status in ('PENDING','QUEUED') and exists(select 1 from public.group_execution_mandates m where m.id=p.mandate_id and m.group_id=p_group_id);

  update public.investment_group_members set membership_state=v_next_state,status=case when v_next_state='LEFT' then 'removed' else 'active' end,left_at=case when v_next_state='LEFT' then v_now else null end,paused_at=v_now,updated_at=v_now where id=v_member.id;
  insert into public.group_member_exit_requests(membership_id,group_id,user_id,exit_policy,idempotency_key,future_entry_revoked_at,completed_at)
    values(v_member.id,p_group_id,p_user_id,p_exit_policy,p_idempotency_key,v_now,case when v_next_state='LEFT' then v_now else null end);
  insert into public.group_member_status_history(membership_id,group_id,user_id,actor_user_id,previous_state,next_state,reason,correlation_id)
    values(v_member.id,p_group_id,p_user_id,p_user_id,v_member.membership_state,v_next_state,'Member requested exit; future-entry authority revoked.',p_idempotency_key);
  insert into public.execution_audit_events(user_id,connection_id,group_id,event_type,severity,operation_purpose,message,safe_metadata)
    values(p_user_id,v_member.broker_connection_id,p_group_id,'GROUP_MEMBER_LEAVE_REQUESTED','WARNING','investment_group_membership','Member exit revoked future-entry authority without manager approval.',jsonb_build_object('membershipId',v_member.id,'exitPolicy',p_exit_policy,'futureEntryRevokedAt',v_now));
  return jsonb_build_object('membershipId',v_member.id,'state',v_next_state,'futureEntryRevokedAt',v_now,'idempotent',false);
end;
$$;

revoke all on function public.leave_investment_group_copy_trading(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.leave_investment_group_copy_trading(uuid,uuid,text,text) to service_role;

create or replace function public.remove_investment_group_member(
  p_actor_user_id uuid,
  p_membership_id uuid,
  p_reason text,
  p_correlation_id text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_member public.investment_group_members%rowtype;
  v_group public.investment_groups%rowtype;
  v_now timestamptz := now();
begin
  if char_length(trim(p_reason)) not between 5 and 500 then raise exception 'A specific removal reason is required' using errcode='22023'; end if;
  select * into v_member from public.investment_group_members where id=p_membership_id for update;
  if not found or v_member.role <> 'member' then raise exception 'Removable member not found' using errcode='42501'; end if;
  select * into v_group from public.investment_groups where id=v_member.group_id;
  if v_group.owner_user_id <> p_actor_user_id and not exists(
    select 1 from public.investment_group_members m where m.group_id=v_member.group_id and m.user_id=p_actor_user_id and m.role='manager' and m.status='active'
  ) then raise exception 'Manager authority required' using errcode='42501'; end if;

  update public.group_execution_mandates set status='REVOKED',revoked_at=v_now,paused_at=v_now
    where group_id=v_member.group_id and follower_user_id=v_member.user_id and status in ('PENDING_CONSENT','ACTIVE','PAUSED','EXIT_ONLY');
  update public.execution_commands c set status='CANCELLED',completed_at=v_now,last_error_code='MEMBER_REMOVED'
    where c.status in ('QUEUED','RETRY') and exists(
      select 1 from public.follower_execution_plans p join public.group_execution_mandates m on m.id=p.mandate_id
      where p.id=c.follower_plan_id and m.group_id=v_member.group_id and p.follower_user_id=v_member.user_id
    );
  update public.follower_execution_plans p set execution_status='CANCELLED',rejection_reason='Membership removal revoked future entry authority.',updated_at=v_now
    where p.follower_user_id=v_member.user_id and p.execution_status in ('PENDING','QUEUED') and exists(select 1 from public.group_execution_mandates m where m.id=p.mandate_id and m.group_id=v_member.group_id);

  -- Removal never force-closes positions. They are detached from manager control
  -- while remaining in the member-owned canonical PositionManager ledger.
  update public.position_lifecycle_positions set group_id=null,membership_id=null,mandate_id=null,origin='MANUAL_BLACK_TERMINAL',updated_at=v_now
    where membership_id=v_member.id and lifecycle_state not in ('closed','archived');
  update public.investment_group_members set membership_state='REMOVED',status='removed',removed_at=v_now,paused_at=v_now,updated_at=v_now where id=v_member.id;
  insert into public.group_removal_events(membership_id,group_id,member_user_id,actor_user_id,reason,future_entry_revoked_at,positions_detached)
    values(v_member.id,v_member.group_id,v_member.user_id,p_actor_user_id,trim(p_reason),v_now,true);
  insert into public.group_member_status_history(membership_id,group_id,user_id,actor_user_id,previous_state,next_state,reason,correlation_id)
    values(v_member.id,v_member.group_id,v_member.user_id,p_actor_user_id,v_member.membership_state,'REMOVED',trim(p_reason),p_correlation_id);
  insert into public.execution_audit_events(user_id,connection_id,group_id,event_type,severity,operation_purpose,message,safe_metadata)
    values(v_member.user_id,v_member.broker_connection_id,v_member.group_id,'GROUP_MEMBER_REMOVED','WARNING','investment_group_membership','Manager removed a member; future entries were revoked and positions were detached without force-closing.',jsonb_build_object('membershipId',v_member.id,'actorUserId',p_actor_user_id,'futureEntryRevokedAt',v_now,'positionsDetached',true,'correlationId',p_correlation_id));
  return jsonb_build_object('membershipId',v_member.id,'state','REMOVED','futureEntryRevokedAt',v_now,'positionsDetached',true,'positionsClosed',false);
end;
$$;

revoke all on function public.remove_investment_group_member(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.remove_investment_group_member(uuid,uuid,text,text) to service_role;

create or replace function public.emergency_stop_investment_group(
  p_actor_user_id uuid,
  p_group_id uuid,
  p_reason text,
  p_correlation_id text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_group public.investment_groups%rowtype;
  v_now timestamptz := now();
  v_paused integer := 0;
begin
  select * into v_group from public.investment_groups where id=p_group_id for update;
  if not found then raise exception 'Investment Group not found' using errcode='P0002'; end if;
  if v_group.owner_user_id <> p_actor_user_id and not exists(
    select 1 from public.investment_group_members m where m.group_id=p_group_id and m.user_id=p_actor_user_id and m.role='manager' and m.status='active'
  ) then raise exception 'Manager authority required' using errcode='42501'; end if;
  update public.investment_groups set emergency_stop=true,emergency_stopped_at=v_now,updated_at=v_now where id=p_group_id;
  update public.group_execution_mandates set status='PAUSED',paused_at=v_now where group_id=p_group_id and status='ACTIVE';
  get diagnostics v_paused = row_count;
  update public.investment_group_members set membership_state='PAUSED_BY_MANAGER',paused_at=v_now,updated_at=v_now
    where group_id=p_group_id and role='member' and membership_state='ACTIVE';
  update public.execution_commands c set status='CANCELLED',completed_at=v_now,last_error_code='GROUP_EMERGENCY_STOP'
    where c.status in ('QUEUED','RETRY') and exists(select 1 from public.group_trade_intents i where i.id=c.group_intent_id and i.group_id=p_group_id);
  update public.follower_execution_plans p set execution_status='CANCELLED',rejection_reason='Group emergency stop cancelled pending entry.',updated_at=v_now
    where p.execution_status in ('PENDING','QUEUED') and exists(select 1 from public.group_trade_intents i where i.id=p.group_intent_id and i.group_id=p_group_id);
  insert into public.execution_audit_events(user_id,group_id,event_type,severity,operation_purpose,message,safe_metadata)
    values(p_actor_user_id,p_group_id,'GROUP_EMERGENCY_STOPPED','CRITICAL','investment_group_execution','Group-wide emergency stop revoked all new-entry execution until a separately authorized recovery.',jsonb_build_object('actorUserId',p_actor_user_id,'pausedMandates',v_paused,'reason',left(p_reason,500),'correlationId',p_correlation_id));
  return jsonb_build_object('groupId',p_group_id,'status','EMERGENCY_STOPPED','pausedMandates',v_paused,'stoppedAt',v_now,'positionsClosed',false,'protectiveOrdersPreserved',true);
end;
$$;

revoke all on function public.emergency_stop_investment_group(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.emergency_stop_investment_group(uuid,uuid,text,text) to service_role;

alter table public.group_risk_disclosure_documents enable row level security;
alter table public.group_risk_acknowledgements enable row level security;
alter table public.investment_group_join_drafts enable row level security;
alter table public.investment_group_invites enable row level security;
alter table public.group_member_risk_policies enable row level security;
alter table public.group_member_risk_policy_versions enable row level security;
alter table public.group_member_portfolio_visibility enable row level security;
alter table public.group_member_status_history enable row level security;
alter table public.group_member_portfolio_snapshots enable row level security;
alter table public.group_aggregate_snapshots enable row level security;
alter table public.group_member_exit_requests enable row level security;
alter table public.group_removal_events enable row level security;
alter table public.obsidian_waitlist_entries enable row level security;

create policy group_risk_documents_authenticated_read on public.group_risk_disclosure_documents for select to authenticated using(status='ACTIVE');
create policy group_risk_acknowledgements_own_read on public.group_risk_acknowledgements for select to authenticated using(user_id=auth.uid() or public.investment_group_can_manage(group_id));
create policy group_risk_acknowledgements_own_insert on public.group_risk_acknowledgements for insert to authenticated with check(user_id=auth.uid());
create policy investment_group_join_drafts_own on public.investment_group_join_drafts for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy investment_group_invites_related_read on public.investment_group_invites for select to authenticated using(recipient_user_id=auth.uid() or public.investment_group_can_manage(group_id));
create policy group_member_risk_policies_related_read on public.group_member_risk_policies for select to authenticated using(exists(select 1 from public.investment_group_members m where m.id=membership_id and (m.user_id=auth.uid() or public.investment_group_can_manage(m.group_id))));
create policy group_member_risk_policy_versions_related_read on public.group_member_risk_policy_versions for select to authenticated using(exists(select 1 from public.investment_group_members m where m.id=membership_id and (m.user_id=auth.uid() or public.investment_group_can_manage(m.group_id))));
create policy group_member_visibility_related_read on public.group_member_portfolio_visibility for select to authenticated using(exists(select 1 from public.investment_group_members m where m.id=membership_id and (m.user_id=auth.uid() or public.investment_group_can_manage(m.group_id))));
create policy group_member_history_related_read on public.group_member_status_history for select to authenticated using(user_id=auth.uid() or public.investment_group_can_manage(group_id));
create policy group_member_snapshots_related_read on public.group_member_portfolio_snapshots for select to authenticated using(exists(select 1 from public.investment_group_members m where m.id=membership_id and m.user_id=auth.uid()));
create policy group_aggregate_snapshots_related_read on public.group_aggregate_snapshots for select to authenticated using(public.investment_group_can_manage(group_id) or exists(select 1 from public.investment_group_members m where m.group_id=group_aggregate_snapshots.group_id and m.user_id=auth.uid()));
create policy group_member_exit_requests_own_read on public.group_member_exit_requests for select to authenticated using(user_id=auth.uid() or public.investment_group_can_manage(group_id));
create policy group_removal_events_related_read on public.group_removal_events for select to authenticated using(member_user_id=auth.uid() or public.investment_group_can_manage(group_id));
create policy obsidian_waitlist_own on public.obsidian_waitlist_entries for select to authenticated using(user_id=auth.uid());

drop policy if exists investment_groups_select_visible on public.investment_groups;
create policy investment_groups_select_visible on public.investment_groups for select using(
  visibility='public' or owner_user_id=auth.uid()
  or exists(select 1 from public.investment_group_members m where m.group_id=investment_groups.id and m.user_id=auth.uid())
  or exists(select 1 from public.investment_group_invites i where i.group_id=investment_groups.id and i.recipient_user_id=auth.uid() and i.status='pending' and i.expires_at>now())
);

drop policy if exists investment_group_members_select_related on public.investment_group_members;
create policy investment_group_members_select_related on public.investment_group_members for select using(
  auth.uid()=user_id or public.investment_group_can_manage(group_id)
);

create policy group_execution_mandates_manager_select on public.group_execution_mandates for select to authenticated using(
  public.investment_group_can_manage(group_id)
);
create policy group_execution_mandate_versions_manager_select on public.group_execution_mandate_versions for select to authenticated using(
  exists(select 1 from public.group_execution_mandates m where m.id=mandate_id and public.investment_group_can_manage(m.group_id))
);
create policy follower_execution_plans_manager_select on public.follower_execution_plans for select to authenticated using(
  exists(select 1 from public.group_execution_mandates m where m.id=mandate_id and public.investment_group_can_manage(m.group_id))
);

drop policy if exists execution_audit_events_manager_group_read on public.execution_audit_events;
create policy execution_audit_events_manager_group_read on public.execution_audit_events for select to authenticated using(
  user_visible=true and group_id is not null and public.investment_group_can_manage(group_id)
);

grant select on public.group_risk_disclosure_documents to authenticated;
grant select,insert on public.group_risk_acknowledgements to authenticated;
grant select,insert,update,delete on public.investment_group_join_drafts to authenticated;
grant select on public.investment_group_invites to authenticated;
grant select on public.group_member_risk_policies,public.group_member_risk_policy_versions,public.group_member_portfolio_visibility,public.group_member_status_history,public.group_member_portfolio_snapshots,public.group_aggregate_snapshots,public.group_member_exit_requests,public.group_removal_events,public.obsidian_waitlist_entries to authenticated;
grant all on public.group_risk_disclosure_documents,public.group_risk_acknowledgements,public.investment_group_join_drafts,public.investment_group_invites,public.group_member_risk_policies,public.group_member_risk_policy_versions,public.group_member_portfolio_visibility,public.group_member_status_history,public.group_member_portfolio_snapshots,public.group_aggregate_snapshots,public.group_member_exit_requests,public.group_removal_events,public.obsidian_waitlist_entries to service_role;
grant usage,select on sequence public.group_member_status_history_id_seq to service_role;

comment on table public.obsidian_waitlist_entries is 'Research-interest only. This table must never represent deposits, shares, balances, lock periods or redemption rights.';
comment on column public.group_execution_mandates.portfolio_visibility is 'Manager UI visibility only; EMS may consume the minimum account-risk data needed for validation.';
comment on table public.group_aggregate_snapshots is 'LATEST is overwritten by the aggregate service; historical rollups are retained at coarser intervals, never per market tick.';

commit;
