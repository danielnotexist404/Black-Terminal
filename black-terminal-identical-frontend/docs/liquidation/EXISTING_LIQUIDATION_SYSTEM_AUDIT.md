# Existing Liquidation System Audit

The prior `LiquidationHeatmapModel` was an OHLCV-distance surface: candle references were projected with fixed `0.92 / leverage` distances, weighted by candle volume, and drawn as Pixi rectangles plus a right-edge histogram. Its appearance and method did not satisfy Event Horizon. It is classified **REMOVE** and has been deleted.

| Component | Classification | Decision |
|---|---|---|
| Legacy LiquidationHeatmapModel | REMOVE | Replaced by BCLIF persistent OI cohorts and a single raster texture. |
| Existing indicator key / permission | REUSE | `liquidationHeatmap` remains the stable entitlement key. |
| Bybit public REST/WS transport | REUSE | Canonical HTTP transport, public WS, reconnect and heartbeat patterns reused. |
| DOM Pro current-book heatmap | REFERENCE_ONLY | Book depth informs forward cascade absorption only; it is not historical position exposure. |
| 202607220001 book heatmap migration | DEPRECATE | It was already reversed by 202607220002 and is not reused. |
| Kioseff / Market Maker Heatmap | REFERENCE_ONLY | Separate model and entitlement; no calculations were reused. |
| Pixi projection and layer stack | REUSE | Price/time transforms and candle-above-overlay ordering retained. |
| Deterministic BCLIF fixture | RETAIN_AS_DEBUG | Explicit `SYNTHETIC_TEST`; never enabled by default or presented as market data. |

No current-order-book histogram is labeled historical, and no current snapshot is stretched backward.
