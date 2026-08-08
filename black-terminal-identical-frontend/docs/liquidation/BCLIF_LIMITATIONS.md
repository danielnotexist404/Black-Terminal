# BCLIF Limitations

- Aggregate OI is paired and not directional.
- Historical entry price, leverage, isolated/cross mix, collateral, hedges and voluntary closes are estimated.
- Until the packaged persistent collector is deployed, public trades, order books, and liquidation events begin at browser connection; no complete three-week history is claimed.
- Historical trade-at-price and order-book absorption accumulate only after the separate analytics collector starts; missing pre-collector history cannot be recreated from OHLCV.
- Bybit linear is the only venue-calibrated implementation in this release; Composite is disabled.
- Current book depth is used only for forward cascade risk.
- Repository deterministic/visual/recovery paths do not substitute for a real 1h/6h/24h collector soak, complete 3W coverage, cross-architecture runtime evidence, or calibrated cascade samples.

This indicator is decision support, not guaranteed liquidation location or trading advice.
