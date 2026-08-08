# BCLIF Limitations

- Aggregate OI is paired and not directional.
- Historical entry price, leverage, isolated/cross mix, collateral, hedges and voluntary closes are estimated.
- Until the packaged persistent collector is deployed, public trades, order books, and liquidation events begin at browser connection; no complete three-week history is claimed.
- Historical trade-at-price and order-book absorption accumulate only after the separate analytics collector starts; missing pre-collector history cannot be recreated from OHLCV.
- Bybit linear is the only venue-calibrated implementation in this release; Composite is disabled.
- Current book depth is used only for forward cascade risk.
- Display-domain clipping, confidence gating, adaptive LOD, thermal normalization, and cluster ranking improve operational readability but do not create additional market evidence or modify cohorts.
- Operational cluster sizes are estimated ranges, not exact liquidation promises; low-confidence uncertainty is intentionally broad and faint.
- Visible Focus and Hybrid normalization may change display contrast with the camera while MODEL and EXPOSURE identities remain invariant.
- Repository deterministic/visual/recovery paths do not substitute for a real 1h/6h/24h collector soak, complete 3W coverage, cross-architecture runtime evidence, or calibrated cascade samples.

Current release state remains repository complete, persistent host not provided, collector not deployed, migrations not applied, and browser fallback active.

This indicator is decision support, not guaranteed liquidation location or trading advice.
