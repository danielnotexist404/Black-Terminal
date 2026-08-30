-- Durable SuperATR state and strategy-owned order amendments.
--
-- TradingView reissues each active strategy.exit on every calculation.  The
-- Strategy Lab worker therefore needs a durable, target-owned MODIFY_ORDER
-- command rather than a browser-local redraw.  These commands remain fenced
-- by the normal execution worker lease and carry an immutable candle key.
begin;

alter table public.strategy_automation_runtime_state
  add column if not exists pine_checkpoint jsonb not null default '{}'::jsonb,
  add column if not exists source_sha256 text,
  add column if not exists settings_sha256 text;

alter table public.strategy_automation_runtime_state
  drop constraint if exists strategy_runtime_pine_checkpoint_check,
  add constraint strategy_runtime_pine_checkpoint_check
    check (jsonb_typeof(pine_checkpoint) = 'object'),
  drop constraint if exists strategy_runtime_source_sha256_check,
  add constraint strategy_runtime_source_sha256_check
    check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  drop constraint if exists strategy_runtime_settings_sha256_check,
  add constraint strategy_runtime_settings_sha256_check
    check (settings_sha256 is null or settings_sha256 ~ '^[0-9a-f]{64}$');

alter table public.execution_commands
  drop constraint if exists execution_commands_strategy_shape_check;
alter table public.execution_commands
  add constraint execution_commands_strategy_shape_check check (
    (strategy_target_binding_id is null and strategy_automation_id is null and strategy_signal_key is null)
    or
    (
      command_type in ('PLACE_ORDER','EXPAND_GROUP_INTENT','MODIFY_ORDER','CANCEL_ORDER')
      and strategy_target_binding_id is not null
      and strategy_automation_id is not null
      and length(strategy_signal_key) between 16 and 512
    )
  );

create index if not exists idx_execution_commands_strategy_order_mutation
  on public.execution_commands(execution_order_id, created_at desc)
  where command_type in ('MODIFY_ORDER','CANCEL_ORDER')
    and execution_order_id is not null
    and strategy_target_binding_id is not null;

comment on column public.strategy_automation_runtime_state.pine_checkpoint is
  'Server-owned confirmed-bar Pine runtime checkpoint; never sourced from the browser.';
comment on column public.strategy_automation_runtime_state.source_sha256 is
  'Pinned SHA-256 of the certified strategy source contract.';
comment on column public.strategy_automation_runtime_state.settings_sha256 is
  'SHA-256 of the immutable running strategy definition used by the checkpoint.';

commit;
