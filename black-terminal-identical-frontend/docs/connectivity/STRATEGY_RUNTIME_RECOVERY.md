# Strategy Runtime Recovery

Chapter II-B adds durable `strategy_deployments` and `strategy_runtime_state` records so strategy
definition, deployment, runtime state, and execution intent are separate concepts. A deployment is
bound to one connection, one versioned mandate, one risk policy, symbol, and timeframe.

## Resume gate

A restarted runtime must restore its persisted indicator/protection state, fetch broker balances,
positions, open orders, and recent executions, reconcile discrepancies, and only then process the
next permitted closed candle. Deterministic signal and intent IDs prevent duplicate entries. New
entries remain blocked while the connection is stale, reconciling, paused, expired, or revoked.

## Current limitation

The durable schema and pause/stop controls exist, but there is not yet a general Black Cloud strategy
evaluator consuming these records. Existing strategy definitions must not be described as fully
browser-independent until that evaluator, state restoration, candle ownership, protection recovery,
and restart certification are implemented. Broker-native protective orders remain the preferred
protection mechanism during this stage.
