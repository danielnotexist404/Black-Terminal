# DOM Pro Signal Stabilization

## Principle

Raw venue data continues ingesting at source cadence. Derived institutional interpretation recalculates and renders at panel cadence. Slowing a visualization never discards the shared raw feed.

## Structural Depth

`PersistentDepthProcessor` records per-price observations, presence, average and median resting size, refill events, cancellation events, and persistence. Structural quantity applies presence, age, and refill weighting. Structural and Macro modes filter transient levels before constructing the cumulative V-shaped depth curve.

The displayed bias is the ratio of cumulative structural bid and ask depth. It is descriptive, not predictive.

## Stable Walls

Walls activate above an activation score and remain eligible until they cross a lower deactivation score. Minimum age/persistence and observation requirements suppress one-frame candidates. Pulled walls remain in lifecycle memory for a bounded horizon. Reliability combines wall score, persistence, and observations. Sorting is refreshed at panel cadence with stable IDs.

Lifecycle currently exposes appearing, active, growing, weakening, and pulled states. Absorbed, migrated, broken, expired, and spoof-suspected states are architecturally reserved for richer venue event history.

## CVD And Flow

Heuristic CVD buckets cumulative trade delta into stable time intervals and applies EMA smoothing before candle construction. Its source, horizon, and smoothing are shown as derived analytics.

Flow Delta clips absolute values at a configurable percentile before smoothing. A single venue burst therefore cannot destroy the panel scale.

## Metrics And Tape

DOM Metrics apply EMA to numeric values. Pulling/stacking changes state only after crossing a hysteresis band and remaining there for the configured confirmation period.

Trade Tape can remove sub-threshold prints and combine same-side, same-price trades inside a grouping interval. Hover freeze suspends the panel scheduler while the shared feed continues.

## Data Quality

Panel headers distinguish LIVE, PARTIAL, and STALE inputs. Derived names remain explicit: Heuristic CVD, Structural Depth, Derived Liquidity Score, and estimated iceberg behavior.
