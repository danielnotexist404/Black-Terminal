# Phase III Chapter VI - DOM Pro+

Status: implemented frontend foundation with institutional liquidity radar redesign.

## Objective

DOM Pro+ turns the compact right-side DOM into a detachable institutional order-flow cockpit while preserving the compact DOM as the docked mode.

The intended flow is:

```text
Exchange WebSocket / REST
-> Market Data Engine
-> Orderbook Cache
-> shared DOM Feed Store
-> DOM Aggregation Engine
-> Compact DOM / DOM Pro+ Renderer
```

DOM Pro+ does not create a separate execution lane. Its quick execution panel creates normalized order intent and routes through:

```text
DOM Pro+ execution panel
-> submitOrder
-> OMS
-> EMS
-> Risk
-> Broker / Protocol Router
```

## Implemented

- Added Black Core module registry and window dock manager scaffolds.
- Registered `dom-pro` as a module that supports compact, expanded, browser-detached, and future Tauri-window modes.
- Added shared market-data subscription multiplexing in `MarketDataEngine` so multiple orderbook/trade consumers for the same venue-symbol share one source subscription.
- Added `DomFeedStore` so compact DOM and DOM Pro+ consume the same market-data state.
- Removed fake compact DOM liquidity fallback. Empty data now shows explicit awaiting/unavailable states.
- Added DOM settings persistence in local storage per workspace and symbol.
- Added DOM aggregation models for:
  - levels
  - buckets
  - aggregated snapshots
  - settings
  - metrics
  - wall detections
  - liquidity deltas
  - absorption signals
  - iceberg estimates
  - render stats
- Added bucket multipliers including `500x` and `1000x`.
- Added DOM modes:
  - Scalper
  - Intraday
  - Standard
  - Institutional
  - Macro
  - Custom
- Changed default DOM Pro+ behavior to institutional mode: wider visible range, larger buckets, lower visual FPS, and a calmer 24H heatmap horizon.
- Added heatmap history horizons:
  - 15M
  - 2H
  - 6H
  - 12H
  - 24H
  - 3D
  - 1W
- Added visible range options:
  - Auto
  - +/-0.25%
  - +/-0.5%
  - +/-1%
  - +/-2%
  - +/-5%
  - Custom
- Added throttled DOM Pro+ rendering with FPS cap settings.
- Added render-cost guard that skips frames when DOM Pro+ render time is high.
- Split raw orderbook ingestion from slower visual rendering with frame throttling and persistent heatmap memory.
- Added detached/expanded DOM Pro+ workspace surface.
- Compact DOM hides when DOM Pro+ is open.
- Browser-detached mode opens a popout window that receives parent DOM snapshots through `BroadcastChannel`.
- Detached popout quick execution sends order intents back to the parent window, where they continue through OMS / EMS / Risk.
- Detached popout receives parent CVD data and renders it without opening its own market-data feed.
- Added compact DOM right-click menu:
  - Open DOM Pro+
  - Detach DOM
  - Send to monitor through detached browser mode
  - Reset DOM layout
  - DOM settings, which opens DOM Pro+ directly into its settings panel
- Added DOM Pro+ panels:
  - Aggregated DOM ladder
  - DOM-aligned volume profile
  - Liquidity heatmap
  - Wall detection
  - Trade tape
  - DOM metrics
  - Depth chart
  - Liquidity flow delta
  - CVD mini panel
  - Performance diagnostics
  - Execution panel
- Added heuristic detection for:
  - sell walls
  - buy walls
  - wall persistence age and persistence percentage
  - first-pass liquidity migration
  - pulling / stacking
  - absorption
  - iceberg probability
- Added institutional heatmap visual treatment:
  - broader persistent horizontal bands
  - red extreme sell/supply pressure
  - white/gray neutral and demand structure
  - current-price line
  - right-side price scale
  - 12H/24H default radar behavior instead of tick-by-tick micro flashing
- Added heatmap viewport controls:
  - mouse-wheel zoom
  - vertical drag pan
  - Shift + wheel pan
  - double-click reset
  - Reset View button
  - hover readout for price, time, intensity, wall, and persistence context
- Replaced the old bounded heatmap viewport with a shared price-space camera used by both the heatmap and volume profile.
- Added camera presets for Current, 1H, 6H, 12H, 24H, 3D, and Fit to Visible Data.
- Allowed broad zoom-out up to macro liquidity map scale without snapping back to current price.
- Prepared the camera model around center price, zoom, offset, and height so a future minimap/navigator can consume the same viewport state.
- Fixed the aggregation slice that could keep only upper ask-side buckets in wide domains; visible bucket selection now preserves both bid/buy buckets below market and ask/sell buckets above market.
- Balanced heatmap memory and wall detection by side so buy walls cannot be starved out by stronger sell-side rankings.
- Added DOM diagnostics for raw bid/ask levels, aggregated bid/ask buckets, buy/sell wall counts, shared domain min/max, rendered heatmap/profile rows, and depth bid/ask points.
- Added real price-domain camera fields for center price, domain min/max, zoom factor, mode, and explicit camera domain.
- Added +/-1%, +/-2%, +/-5%, +/-10%, +/-20%, and Full Data camera presets.
- Expanded the DOM aggregation domain for wide/full ranges so source depth is retained for camera navigation instead of capped by the visible ladder row limit.
- Added raw-orderbook fallback for the depth chart, so raw bid/ask data can still render if aggregated buckets are missing.
- Expanded diagnostics with best bid/ask, mid price, min/max side prices, total bid/ask size, selected visible range, computed domain, camera domain, and exact debug reason.
- Added a historical OHLCV macro radar layer using cached/fetched daily candles from the existing Market Data Engine.
- Added macro structure bands for POC, supply, and demand zones across a wider historical range.
- Aligned the volume profile to the same vertical viewport used by the heatmap.
- Volume Profile now renders a continuous camera-domain scaffold with an outline and price scale, so zoomed-out views preserve the visible range even when liquidity only exists in part of the domain.
- Replaced the depth chart block bars with a cumulative bid/ask depth curve.
- Made the depth chart inherit the same visible price camera as the heatmap.
- Restored the depth chart around a current-price center reference with bid cumulative depth on the lower-price side and ask cumulative depth on the higher-price side.
- Depth chart now prefers raw L2 levels over aggregated buckets, maps price to the shared camera domain, and extends available curves to the viewport edges instead of disappearing when institutional buckets collapse into one row.
- Depth chart now renders one available side with an explicit source warning instead of going blank.
- Replaced liquidity flow blocks with rolling time-bucket histogram bars and percentile outlier scaling.
- Redesigned CVD as a larger heuristic CVD panel with current delta, session delta, aggressive buy percentage, aggressive sell percentage, trend label, horizon controls, EMA smoothing, and a thicker line.
- Updated institutional defaults to 500x buckets, +/-2% visible range, 24H heatmap, 4H smoothed CVD, and 10-12 FPS behavior.
- Added performance diagnostics:
  - updates/sec
  - render FPS
  - visible buckets
  - bucket size
  - dropped frames
  - render time
  - memory estimate
  - subscription count

## Data Integrity Rules

- No fake DOM liquidity is rendered by the compact DOM or DOM Pro+.
- Historical macro bands are derived from real OHLCV candles and labeled as historical structure, not as live resting orderbook liquidity.
- Live DOM walls continue to come from current orderbook depth and persistent DOM memory.
- If orderbook data is missing, the UI shows `Awaiting live orderbook stream.`
- If heatmap history is missing, the UI shows `Liquidity heatmap requires depth history.`
- If trade tape data is missing, the UI shows `Trade stream unavailable for this venue.`

## Current Limitations

- Browser-detached mode depends on the parent workspace remaining open because the parent owns the market-data feed and OMS/EMS execution context.
- If a browser blocks popups, the parent workspace shows a detached-controller state and the user can close/reopen DOM Pro+ in-workspace.
- Wall, absorption, and iceberg readings are first-pass heuristics and are labeled accordingly.
- DOM Pro+ settings currently persist locally. No Supabase table is required yet.
- Worker/Rust offload is prepared by keeping aggregation separate from React, but aggregation still runs in the browser thread.

## Validation

- `npm run build` passes.

## Next Work

- Move aggregation to Web Worker once real depth load requires it.
- Add layout persistence for detached window geometry.
- Upgrade the browser popout from BroadcastChannel bridge to Shared Worker if multiple detached DOM windows need cross-tab feed ownership.
- Add server-persisted DOM workspaces if users need cross-device DOM layouts.
