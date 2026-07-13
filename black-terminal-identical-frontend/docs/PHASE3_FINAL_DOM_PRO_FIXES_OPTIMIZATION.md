# Phase III Final DOM Pro Refinement

## Status

Implemented and locally validated. This chapter refines the existing DOM Pro cockpit; it does not introduce another market-data or execution path.

## Delivered

- All ten configurable panels expose a compact settings cog in the panel header.
- Settings open in a viewport-constrained, keyboard-accessible popover and apply live.
- Each panel has versioned defaults, a selected preset, user overrides, reset, save-as-default, diagnostics, and local workspace/symbol persistence.
- Scalper, Intraday, Institutional, and Macro workspace presets coordinate panel presets. A later individual change remains a user override.
- One `DomPanelUpdateScheduler` coalesces independent calculation and render cadences and suspends panels while hidden or hover-frozen.
- Depth uses continuously ingested rolling depth, persistence weighting, snapshot averaging, refill/cancellation observations, stable structural modes, and an explicit non-predictive bias summary.
- Wall detection uses activation/deactivation hysteresis, minimum persistence and observations, lifecycle retention, reliability ranking, and stable row order.
- Heuristic CVD uses time buckets and EMA smoothing over selectable horizons.
- DOM metrics use EMA stabilization and confirmation-duration hysteresis.
- Trade Tape can filter and aggregate repeated prints. Liquidity Flow Delta uses percentile clipping and smoothing.
- Raw and derived surfaces are labeled and expose quality and scheduler diagnostics.

## Architecture

```text
Venue adapters
  -> one Black Core orderbook/trade feed
  -> DOM aggregation worker (latest-wins)
  -> shared normalized snapshot
  -> panel scheduler
  -> panel-specific derived processors
  -> panel render models
```

No panel creates an exchange subscription, IMM fetch loop, worker, or uncontrolled timer.

## Validation

- `npm run test:dom-pro-panels`
- `npm run test:performance`
- `npm run build`
- `npm run test:dom-pro-visual`: 14 captures covering all headers, all ten panel popovers, and coordinated Scalper/Institutional/Macro presets.
- One-hour Chapter XIV browser soak: 60 samples over 3,604,022 ms; all eight gates passed. Listener, interval, animation-frame, observer, and worker-queue growth were zero. Report: `docs/performance/soak-2026-07-13T19-05-16-269Z-summary.json`.

## Limitations

- Panel preferences currently use the versioned browser fallback. Server-side user preference persistence remains future work.
- Persistent depth becomes more authoritative as continuous venue history accumulates. It is explicitly marked derived.
- Venue depth quality remains bounded by the source adapter's level count and update frequency.
