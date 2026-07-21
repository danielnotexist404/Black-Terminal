# Roadmap

## Phase 0: Workspace Foundation

- Keep the current Vite, React, Tauri, and PixiJS stack buildable.
- Document the product brief, architecture, workspace commands, and indicator contract.
- Add basic repository hygiene and editor configuration.

## Phase 1: Chart Engine Core

- Split draw logic into layer modules.
- Add scale and viewport tests.
- Replace immediate candle drawing with batched geometry.
- Add stable hit testing for candles, drawings, and indicators.
- Add keyboard shortcuts, tooltips, and workspace state.

## Phase 2: Market Data

- Add exchange adapter interfaces.
- Implement websocket and historical candle adapters for Binance, Bitfinex, OKX, Bybit, and
  Hyperliquid.
- Add secondary adapters for Coinbase, Kraken, Bitstamp, Deribit, Bitget, KuCoin, Gate.io, MEXC,
  and BitMEX.
- Move candle aggregation off the UI path.
- Normalize trades, order books, funding rates, open interest, liquidations, and symbol metadata.
- Add replay and local cache support.

## Phase 3: Python Indicators

- Implement the indicator protocol and validation.
- Run indicators outside the UI thread.
- Add parameter controls, plot routing, and diagnostics.
- Add a permission model for local and community scripts.

## Phase 4: Trading Workflows

- Add alert builder and strategy tester.
- Add DOM/order book interactions.
- Add simulated execution and position state.
- Add secure account connection flows with read-only mode first.
- Add execution adapters for supported exchanges after market data adapters are stable.
- Add paper trading, risk guards, and manual approval controls before live automation.
- Add exportable workspace templates.

## Phase 5: Webhooks and Automation

- Expand outbound webhooks for alerts, signals, strategy runs, and order updates.
- Add signed inbound webhook endpoints for external algorithm systems.
- Add strategy run logs with trigger, decision, exchange response, and rejection reason.
- Add live/paper mode separation for all automated actions.

## Phase 6: Community and Distribution

- Add indicator package metadata, signing, and versioning.
- Add browsing, search, ratings, and discussion surfaces.
- Add update channels and packaging automation.
- Validate mobile runtime assumptions for iPad and iPhone.
