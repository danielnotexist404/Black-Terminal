# BCLIF Bybit Data Adapter

## Primary contracts

BCLIF is implemented against Bybit's official V5 public contracts, not reverse-engineered browser payloads:

- [public WebSocket connection](https://bybit-exchange.github.io/docs/v5/ws/connect), [public trades](https://bybit-exchange.github.io/docs/v5/websocket/public/trade), [all liquidations](https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation), and [order book](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook);
- [historical open interest](https://bybit-exchange.github.io/docs/v5/market/open-interest), [funding history](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate), [long/short ratio](https://bybit-exchange.github.io/docs/v5/market/long-short-ratio), [risk limits](https://bybit-exchange.github.io/docs/v5/market/risk-limit), [instrument information](https://bybit-exchange.github.io/docs/v5/market/instrument), and [tickers](https://bybit-exchange.github.io/docs/v5/market/tickers).

Adapters are versioned because exchange schemas and availability can change. A source-version mismatch is a recovery boundary, never an invitation to reinterpret stored events silently.

REST inputs include `/v5/market/open-interest`, funding history, account ratio, risk limit, instrument info, and tickers. Live topics include `publicTrade.{symbol}`, `allLiquidation.{symbol}`, `orderbook.50.{symbol}`, and ticker context. The persistent adapter preserves exchange/receive timestamps, trade IDs and cross sequences, detects regressions/out-of-order input, sends a 20-second ping, and reconnects with bounded jittered backoff.

Order-book snapshots replace both maps; deltas insert/update and zero size deletes. Update ID 1 forces replacement. Cross sequence must be monotonic but is not assumed consecutive. Transport loss, malformed/crossed state, regression, or staleness triggers explicit resynchronization. Only reconstructed controlled-cadence book frames are archived.

`singleOpenInterest` is used when present. When only the documented both-sides `openInterest` sum is available, BCLIF halves it to prevent paired exposure from being counted twice. Trade side is the exchange taker side. Under Bybit's current all-liquidation contract, `S=Buy` means a liquidated long and `S=Sell` a liquidated short. Current rules applied to pre-observation history are marked estimated rather than silently presented as historically known.
