# BCLIF Thermal Field Recovery

## Production symptom

A restored workspace displayed two or three short red, white, or grey cohort
shelves while the CoinGlass-style thermal field was absent. The model and OI
bootstrap were alive; this was not a zero-exposure state.

## Exact root cause

Renderer schemas through V7 treated rawCohortShelvesVisible as an exclusive
presentation mode. The flag did two independent things:

1. it enabled the diagnostic shelf strokes;
2. it set the GPU thermal sprite to invisible.

Because the flag was persisted in workspace state, a previously selected Raw
Model or shelf-diagnostic state survived deployment and hard refresh. The shelf
geometry continued to move as live cohort state changed, creating the appearance
of glitching shelves.

## Renderer V8 contract

- The thermal texture and raw shelf diagnostics are independent layers.
- Enabling raw shelves adds an overlay; it never hides the thermal sprite.
- Selecting an operational preset disables the diagnostic overlay.
- A pre-V8 workspace restored in the incompatible shelf-only state is migrated
  to Trade Focus, Combined Thermal, Reference Thermal, Chart Scale, the default
  three-week horizon, and collapsed diagnostics.
- Other indicators, workspace preferences, and BCLIF cohort mathematics are not
  changed.

The renderer continues to map the snapshot only to its genuine timestamp range.
It does not stretch a short model window over unevidenced history.

## Authority boundary

Browser fallback can render a dense, high-resolution OI-derived thermal context,
but color authority remains evidence-aware. Low-confidence OI-only context is
visible in purple/blue; green/yellow remains gated until the configured evidence
and confidence threshold is satisfied. The persistent collector is still
required for continuous historical trade, liquidation, and order-book memory.
