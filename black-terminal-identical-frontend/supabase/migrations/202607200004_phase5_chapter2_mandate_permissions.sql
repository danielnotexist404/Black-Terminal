-- Phase V, Chapter II: explicit investor execution permissions.
begin;

alter table public.group_execution_mandates
  add column if not exists allow_open_positions boolean not null default true,
  add column if not exists allow_close_positions boolean not null default true,
  add column if not exists allow_modify_protection boolean not null default true,
  add column if not exists allow_withdrawals boolean not null default false,
  add column if not exists allow_asset_transfers boolean not null default false;

alter table public.group_execution_mandates
  drop constraint if exists group_execution_mandates_no_withdrawals,
  add constraint group_execution_mandates_no_withdrawals check (allow_withdrawals = false),
  drop constraint if exists group_execution_mandates_no_transfers,
  add constraint group_execution_mandates_no_transfers check (allow_asset_transfers = false);

alter table public.broker_connection_capabilities
  add column if not exists can_transfer boolean not null default false;
alter table public.broker_connection_capabilities
  drop constraint if exists broker_connection_capabilities_no_transfer,
  add constraint broker_connection_capabilities_no_transfer check (can_transfer = false);

commit;
