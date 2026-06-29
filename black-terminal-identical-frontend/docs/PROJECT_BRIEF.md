# Black-Terminal Project Brief

Black-Terminal is an advanced charting and trading terminal aimed at the speed and depth of
professional platforms while keeping the interaction model closer to TradingView: direct,
visual, responsive, and comfortable for long sessions.

## Product Goals

- Deliver a custom charting engine that feels smoother and more responsive than embedded chart
  widgets.
- Support Python for user-built indicators instead of a restricted domain language.
- Keep the UI elegant and approachable while still supporting Quantower-style professional
  workflows: DOM, order book, alerts, strategy tools, market stats, layouts, and execution panels.
- Pull normalized charting data from Binance, Bitfinex, OKX, Bybit, Hyperliquid, and other major
  exchanges through a shared adapter layer.
- Support user account connections for authenticated trading after secure credential storage,
  account permissions, and risk controls are implemented.
- Support webhook-driven strategy workflows for alerts, external algorithm systems, and automated
  execution after the strategy engine can enforce safety limits.
- Prepare for a future community layer where users can browse, publish, rate, and discuss
  indicators, layouts, and strategies.
- Keep the codebase ready for downloadable desktop first, then validate the mobile packaging path
  for iPad and iPhone before committing to platform-specific runtime assumptions.

## Current Foundation

- Frontend shell: React + Vite + TypeScript.
- Native wrapper: Tauri 2 with a Rust command layer.
- Chart renderer: custom PixiJS renderer, not TradingView Lightweight Charts.
- Current data source: deterministic mock candles plus a mock live feed.
- Current backend command: webhook dispatch from Rust through Tauri.
- Current exchange/trading foundation: typed contracts for market data, execution, and automation.

## Product Principles

- The chart is the product center. UI panels should support it, not compete with it.
- Rendering and data flow must stay off the React render loop wherever possible.
- Indicators must be deterministic, portable, sandboxed, and easy to share.
- Python indicators should emit plots and signals; they should not directly hold API keys or place
  live trades.
- Automated execution must pass through a strategy engine, explicit permissions, and risk guards.
- User workflows should favor direct manipulation, saved workspaces, and fast context switching.
- Community features should be designed as signed packages with metadata, versioning, and trust
  boundaries from day one.
