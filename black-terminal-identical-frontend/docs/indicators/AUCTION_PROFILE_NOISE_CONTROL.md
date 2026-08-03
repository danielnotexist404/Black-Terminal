# Auction Profile Noise Control

Structural interpretation is calculated separately from matrix evidence and is opt-in by default.

## Default

- POC: on;
- VAH/VAL: on;
- IB: on;
- midpoint: off;
- LVN/HVN zones: off;
- node labels: off;
- structural S/R: off;
- historical extensions: off;
- aggregate histogram: off.

## Ranking and budgets

Nodes are ranked by prominence and normalized strength before rendering. Detail modes cap each side:

- Minimal: one LVN and one HVN;
- Standard: three each;
- Detailed: ten each;
- Research: settings budget.

Independent maximum LVN, HVN, structural-zone, row, column, and label budgets protect readability without deleting analytical state.

## Extensions

Profile Only is the default. Fixed N Bars, Extend Right, Full Chart, and lifecycle-named extension modes are available. Full Chart is never selected automatically. The current renderer treats touch/mitigation/invalidation choices as rightward presentation extensions; candle-event termination for those three lifecycle names remains future structural-state work.
