# BC-RDA Causal V2 Model

`BC_RDA_CAUSAL_V2` is a separately versioned reconstruction. It does not reinterpret the repainting marker as final; it separates a developing analytical candidate from a confirmed event.

## Causal inputs

For bar `t`, the price/equity source is Close, HLC3, or OHLC4 according to settings. Peak, smoothing, distribution, duration, velocity, VADD, and risk-state calculations use only bars `0..t`:

- `peak_t = max(source[max(0,t-L+1)..t])` for rolling mode, otherwise the running all-history maximum.
- `drawdown_t = min(0, (source_t / peak_t - 1) * 100)`.
- `depth_t = max(0, -drawdown_t)`.
- `velocity_t = depth_t - depth_(t-1)`.
- distribution bands are trailing rolling quantiles over at most configured lookback `L`.

No viewport, zoom, visible-range, or future candle is an engine input.

## Signal state machine

`CausalRdaSignalMachine` in `src/modules/dda-pro/core/causalSignalEngine.ts` consumes closed-bar frames in ascending time order.

1. A developing episode starts when `depth >= episodeThreshold`.
2. A deeper closed bar updates only the developing candidate anchor.
3. Recovery evidence accumulates only while `velocity < 0` and depth improves.
4. Required recovery bars are `clamp(round(minimumExcursionBars), 1, 5)`.
5. Minimum improvement is `max(episodeThreshold * 0.25, candidateDepth * 0.03)`.
6. A Long becomes final on the first closed bar satisfying recovery count and improvement. A full recovery (`depth < episodeThreshold * 0.05`) also confirms a prior trough causally.
7. Full recovery arms a Short upper-extreme candidate but emits no Short. A later Short becomes final only after `requiredRecoveryBars` consecutive closed bars of worsening depth/positive drawdown velocity and depth of at least `max(episodeThreshold * 0.25, recoveryThreshold)`.

Final markers are placed on the confirmation bar. `displayAnchorIndex` retains the candidate trough solely as analytical provenance; it is never the execution timestamp.

Short signals use a separate causal exhaustion sequence. Full recovery arms an upper-extreme candidate, later closed-bar highs may update only the developing analytical anchor, and a Short becomes final only after the configured number of positive drawdown-velocity bars plus the minimum rollover depth. The historical upper-extreme anchor is provenance; the red trading marker remains on the later rollover-confirmation bar.

## Boundary

Source-level causality is certified by the repository harness. Alerts and Strategy Lab remain blocked because browser/worker parity is not the same as certification of the independent persistent VPS/headless execution runtime.
