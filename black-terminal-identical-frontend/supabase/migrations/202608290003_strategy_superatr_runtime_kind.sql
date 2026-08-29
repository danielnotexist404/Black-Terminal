-- Keep the database runtime allowlist aligned with the Strategy Lab domain.
-- SuperATR drafts were previously accepted by the API schema but rejected by
-- the original strategy_automation_strategies check constraint.
begin;

alter table public.strategy_automation_strategies
  drop constraint if exists strategy_automation_strategies_runtime_kind_check;

alter table public.strategy_automation_strategies
  add constraint strategy_automation_strategies_runtime_kind_check
  check (runtime_kind in (
    'builtin-ema-cross',
    'builtin-adaptive-swing',
    'builtin-superatr-seven-step',
    'python-script',
    'external-signals'
  ));

commit;
