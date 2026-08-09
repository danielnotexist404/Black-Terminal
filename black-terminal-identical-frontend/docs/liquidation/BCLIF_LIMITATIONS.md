# BCLIF Limitations

- Aggregate OI is paired and not directional.
- Historical entry price, leverage, isolated/cross mix, collateral, hedges and voluntary closes are estimated.
- Browser history uses canonical lower-timeframe volume/price approximation when exact historical public trades are unavailable; this is capped at 60% authority and is not observed account inventory.
- Until the packaged persistent collector is deployed, public trades, order books, and liquidation events begin at browser connection; no complete three-week history is claimed.
- Historical trade-at-price and order-book absorption accumulate only after the separate analytics collector starts; missing pre-collector history cannot be recreated from OHLCV.
- Bybit linear is the only venue-calibrated implementation in this release; Composite is disabled.
- Current book depth is used only for forward cascade risk.
- Display-domain clipping, confidence gating, adaptive LOD, thermal normalization, and cluster ranking improve operational readability but do not create additional market evidence or modify cohorts.
- Operational cluster sizes are estimated ranges, not exact liquidation promises; low-confidence uncertainty is intentionally broad and faint.
- Funding-driven liquidation adjustment is currently zero and is not claimed as modeled. A future implementation must be causal, incremental, separately versioned, and visibly attributed.
- Cross-margin account equity is unknowable from public data. Cross/unknown particles are capped, broad, and faint rather than presented as sharp levels.
- Persistent V5 cohort provenance requires a collector/checkpoint-derived sidecar. Until a V5 collector is actually deployed, persistent multi-week cohort provenance and event calibration are not production-certified.
- Visible Focus and Hybrid normalization may change display contrast with the camera while MODEL and EXPOSURE identities remain invariant.
- Repository deterministic/visual/recovery paths do not substitute for a real 1h/6h/24h collector soak, complete 3W coverage, cross-architecture runtime evidence, or calibrated cascade samples.

Current release state remains repository complete, persistent host not provided, collector not deployed, migrations not applied, and browser fallback active.

This indicator is decision support, not guaranteed liquidation location or trading advice.
# Chapter III-C4 limitations

- Browser fallback still reconstructs a bounded session model and is not
  durable market memory.
- Historical browser trade, liquidation, and order-book evidence remains
  unavailable and is not synthesized; those columns are OI/price context.
- The V6 event window reduces OI polling fragmentation but cannot identify
  individual accounts or exact leverage/collateral.
- Cross and unknown margin estimates are broad, low-authority hypotheses.
- A controller-generation grid is stable during refresh; a deliberate model
  grid-row change creates a new generation.
- The public 2-hour replay harness exists, but the 2026-08-09 run was blocked
  before network execution by approval timeout.
- Persistent host, collector, migrations, soak, and persistent replay remain
  inactive.
