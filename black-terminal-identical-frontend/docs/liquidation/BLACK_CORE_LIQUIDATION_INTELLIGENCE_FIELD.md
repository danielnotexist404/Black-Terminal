# Black Core Liquidation Intelligence Field

BCLIF replaces the old Liquidation Heatmap renderer. It converts positive open-interest expansions into paired long/short position hypotheses, distributes each hypothesis across explicit leverage and risk-tier particles, propagates survival through time, assimilates confirmed Bybit liquidations, and rasterizes remaining vulnerable notional over time × price.

The chart receives one typed snapshot from a worker and uploads one RGBA texture to Pixi. Candles render later in the layer stack. The default Event Horizon preset requests three weeks, 512 time columns, 384 price rows, confidence-weighted log scaling, and the reference thermal palette.

The browser is a live-session collector only. Persistent multi-week trade, book and liquidation history requires the future IMM/BCLIF collector node; browser uptime is never described as complete historical coverage.
