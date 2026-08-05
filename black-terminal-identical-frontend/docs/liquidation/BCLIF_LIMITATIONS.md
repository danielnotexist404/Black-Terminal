# BCLIF Limitations

- Aggregate OI is paired and not directional.
- Historical entry price, leverage, isolated/cross mix, collateral, hedges and voluntary closes are estimated.
- Public liquidation messages begin when the browser session connects; no complete three-week event history is claimed.
- Historical trade-at-price and order-book absorption require a persistent collector.
- Bybit linear is the only venue-calibrated implementation in this release; Composite is disabled.
- Current book depth is used only for forward cascade risk.
- Deterministic visual topology tests pass, but multi-resolution SSIM and long live-soak certification remain pending.

This indicator is decision support, not guaranteed liquidation location or trading advice.
