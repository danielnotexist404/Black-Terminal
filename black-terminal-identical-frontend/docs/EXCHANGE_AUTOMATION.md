# Exchange Data, Trading, and Automation

## Persistent execution rule

The browser may create authenticated intents and controls but cannot own automation. Persistent
execution requires an active signed broker automation mandate, an encrypted server credential, a
healthy synchronized Black Cloud worker connection, OMS/EMS approval, and the provider's normalized
adapter. Ordinary UI logout does not revoke that explicit authority. Withdrawal-enabled credentials
are rejected.

Current certification is intentionally narrow: Bybit has the only registered persistent adapter and
still requires external testnet certification; Hyperliquid has a non-persistent request relay;
MetaMask and Phantom are interactive signers; all remaining listed CEX adapters are public market
data only. See `docs/connectivity/BROKER_CERTIFICATION_MATRIX.md`.

Black-Terminal should treat market data, account trading, Python indicators, and automated strategy
execution as separate systems that communicate through typed contracts.

## Exchange Data Goal

The charting layer should support all major exchanges through adapters. Priority adapters:

- Binance
- Bitfinex
- OKX
- Bybit
- Hyperliquid

Secondary major adapters:

- Coinbase
- Kraken
- Bitstamp
- Deribit
- Bitget
- KuCoin
- Gate.io
- MEXC
- BitMEX

The adapter registry is intentionally extensible so new exchanges can be added without changing the
chart engine.

## Data Types

Every exchange adapter should normalize exchange-specific payloads into shared app types:

- Historical candles
- Live candles
- Trades tape
- Order book snapshots and deltas
- Funding rates
- Open interest
- Liquidations, where available
- Symbol metadata and precision rules

The chart engine should only consume normalized data. It should never know whether candles came from
Binance, OKX, a replay file, a broker, or a mock adapter.

## Account and Trading Integration

Trading access must be isolated from chart rendering and indicator execution.

- API keys should never be stored in React state or plain local storage.
- Trading adapters should run through the native layer or a secure backend service.
- User keys should be created with withdrawal disabled.
- Permissions should be explicit: read-only, place orders, cancel orders, modify orders.
- Live trading should require a paper-trading mode, risk limits, and clear manual controls before
  automated execution is enabled.

## Webhooks and Automated Strategies

Webhook integrations should support both outbound alerts and inbound automation triggers.

- Outbound: send alert, signal, strategy, and execution events to external systems.
- Inbound: receive signed webhook payloads that can trigger strategies.
- Execution must pass through a risk guard before any live order is placed.
- Strategy logs should include trigger, action, rejection reason, exchange response, and timestamp.
- Live mode should be visually distinct from paper mode.

## Python Indicators

Python indicators should produce signals and plots, not directly place trades. The strategy engine can
consume indicator signals and decide whether an action is allowed.

This keeps community scripts useful while preserving safety boundaries:

- Indicator runtime: analysis and signals.
- Strategy engine: rules, risk checks, webhook decisions.
- Execution adapter: authenticated trading actions.

## Code Contracts

Current scaffold:

```text
src/market-data/types.ts
src/market-data/exchangeRegistry.ts
src/market-data/adapters/binance.ts
src/execution/types.ts
src/automation/types.ts
```

These files define the boundaries before implementation of live WebSocket, REST, API-key, and
strategy-runner code begins.

## Black Cloud production boundary

Bybit Demo and Mainnet Live are the only active Black Cloud execution environments; Testnet is not used. Browser automation delegates signed, versioned intents to Supabase. `BLACK_CLOUD_NODE_01` consumes them only after config, vault/mandate self-test, schema, lease, queue, reconciliation and clock gates pass. The worker instance is ephemeral while the node identity is stable. New submissions stop on unsafe clock or lost fencing. Strategy runtime remains disabled until an actual browser-offline strategy lifecycle is externally certified; no UI or Investment Group module may call the adapter directly.

## Implementation Status

- Binance public historical candles are implemented through the normalized market-data adapter.
- Binance live kline, trade, and partial order-book WebSocket subscriptions are scaffolded.
- The chart can replace mock candles with live Binance `BTCUSDT` perpetual candles and keep
  updating from the kline stream.
- If Binance is unavailable, blocked, or fails from the user network, the app keeps the mock feed as
  a fallback instead of blanking the chart.
- DOM/order book, trades tape, market stats, and funding panels are still using mock rows until the
  adapter streams are wired into those React panels.

## Investment Group automation boundary

Group managers create canonical trade intents; they do not call exchange adapters. The worker re-reads the member and mandate immediately before broker submission, applies the member's effective leverage/risk ceilings, and creates an independent follower plan and idempotency identity. Pause, leave, removal and emergency stop fence future entries while preserving broker-native protection. See `docs/investment-groups/COPY_TRADING_MANDATE.md`.
