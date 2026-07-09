# Phase III Chapter VI - DOM Pro+

Status: implemented frontend foundation.

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
  - Micro
  - Scalper
  - Standard
  - Swing
  - Macro
  - Custom
- Added visible range options:
  - Auto
  - +/-0.25%
  - +/-0.5%
  - +/-1%
  - +/-2%
  - +/-5%
  - Custom
- Added throttled DOM Pro+ rendering with FPS cap settings.
- Added detached/expanded DOM Pro+ workspace surface.
- Compact DOM hides when DOM Pro+ is open.
- Added compact DOM right-click menu:
  - Open DOM Pro+
  - Detach DOM
  - Send to monitor
  - Reset DOM layout
  - DOM settings
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
  - pulling / stacking
  - absorption
  - iceberg probability
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
- If orderbook data is missing, the UI shows `Awaiting live orderbook stream.`
- If heatmap history is missing, the UI shows `Liquidity heatmap requires depth history.`
- If trade tape data is missing, the UI shows `Trade stream unavailable for this venue.`

## Current Limitations

- Browser-detached and Tauri-native modes are represented in the module/window architecture, but the current runtime opens DOM Pro+ as an expanded in-workspace module to avoid duplicate full-app windows.
- Wall, absorption, and iceberg readings are first-pass heuristics and are labeled accordingly.
- DOM Pro+ settings currently persist locally. No Supabase table is required yet.
- Worker/Rust offload is prepared by keeping aggregation separate from React, but aggregation still runs in the browser thread.

## Validation

- `npm run build` passes.

## Next Work

- Move aggregation to Web Worker once real depth load requires it.
- Add layout persistence for detached window geometry.
- Add true browser popout via a shared worker or BroadcastChannel feed bridge so detached windows still avoid duplicate exchange feeds.
- Add server-persisted DOM workspaces if users need cross-device DOM layouts.
