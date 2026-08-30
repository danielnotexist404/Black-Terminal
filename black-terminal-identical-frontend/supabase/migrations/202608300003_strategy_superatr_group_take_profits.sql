-- Permit the seven signed SuperATR follower exits introduced by the strategy
-- broker/group runtime. The earlier group-execution constraint admitted only
-- direction-sync intents, so a valid TAKE_PROFIT row was rejected before it
-- could reach any follower account.
begin;

alter table public.group_trade_intents
  drop constraint if exists group_trade_intents_strategy_action_check,
  add constraint group_trade_intents_strategy_action_check check (
    strategy_action is null
    or strategy_action in ('SYNC_DIRECTION','TAKE_PROFIT')
  ),
  drop constraint if exists group_trade_intents_strategy_shape_check,
  add constraint group_trade_intents_strategy_shape_check check (
    (
      strategy_automation_id is null
      and strategy_target_binding_id is null
      and strategy_action is null
      and strategy_direction is null
    )
    or
    (
      strategy_automation_id is not null
      and strategy_target_binding_id is not null
      and strategy_action in ('SYNC_DIRECTION','TAKE_PROFIT')
      and strategy_direction in ('long','short')
    )
  );

commit;
