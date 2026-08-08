# BCLIF Persistent Collector

`LIQUIDATION_INTELLIGENCE_NODE_01` is a Node 22 public-market analytics service under `server/liquidation-intelligence`. It is deliberately separate from Black Cloud execution and uses no broker credentials.

The collector consumes official Bybit V5 public trades, all-liquidation events, order-book snapshots/deltas, OI, funding, mark/index prices, ratios, instrument metadata, and risk tiers. It normalizes them into timestamped canonical events, advances the shared BCLIF cohort engine on explicit `[start,end)` frames, and publishes immutable numerical tiles only after their source cutoff.

The stable node ID is configuration. A random instance ID is generated on every start. The worker does not publish `LIVE` until configuration, database schema, private storage, checkpoint recovery, replay, source reconciliation, and clock checks complete. Secondary-source staleness degrades confidence rather than fabricating substitutes.

The collector owns historical model authority. A browser may run the legacy model only after the protected status path confirms that persistent data is unavailable and entitlement is valid.

Official source contracts:

- https://bybit-exchange.github.io/docs/v5/websocket/public/trade
- https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation
- https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook
- https://bybit-exchange.github.io/docs/v5/market/open-interest
