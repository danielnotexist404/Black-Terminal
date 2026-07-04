# Black Core Phase II

Phase II introduces Black Core as the platform layer between React, the Pixi chart engine, exchanges, wallets, portfolios, and execution.

## Implemented Foundation

- `src/core/events/` provides a typed event bus for normalized market, portfolio, order, and performance events.
- `src/core/services/` provides a service registry for dependency injection.
- `src/core/platform/` isolates runtime concerns for browser now and desktop/Tauri later.
- `src/market-data/engine/` provides the Market Data Engine facade used by UI/chart modules.
- `src/market-data/cache/` stores normalized candles, trades, tickers, order books, funding, open interest, and mark prices.
- `src/market-data/aggregation/` provides trade-to-candle aggregation for shared timeframe generation.
- `src/market-data/websocket/` provides a reusable WebSocket Manager for pooled connections, reconnects, subscriptions, latency, and diagnostics.
- `src/broker/brokerFramework.ts` defines the broker adapter registry.
- `src/wallets/walletFramework.ts` keeps wallet adapters independent from centralized exchange adapters.
- `src/portfolio/portfolioService.ts` and `src/orders/orderSyncService.ts` provide normalized account/order state services.
- `src/performance/performanceMonitor.ts` publishes performance metrics to Black Core events.

## Current Integration

The existing chart and symbol discovery now consume market adapters through the Market Data Engine facade instead of importing exchange adapters directly.

Existing exchange adapters remain in place as implementation details. Future work should migrate their duplicated WebSocket code into the shared WebSocket Manager.

## Next Steps

- Move exchange-specific WebSocket implementations into the shared `WebSocketManager`.
- Add direct engine subscriptions for DOM, scanner, alerts, strategy lab, and portfolio services.
- Add a live worker for portfolio/order synchronization.
- Publish chart execution markers from execution reports through Black Core events.
