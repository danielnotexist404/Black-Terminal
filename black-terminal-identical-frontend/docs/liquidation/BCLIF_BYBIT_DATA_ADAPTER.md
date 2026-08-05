# BCLIF Bybit Data Adapter

REST inputs are `/v5/market/open-interest`, `/v5/market/risk-limit`, and `/v5/market/tickers`. Live topics are `publicTrade.{symbol}`, `allLiquidation.{symbol}`, and `orderbook.50.{symbol}`. Snapshot messages reset the book; deltas update price levels; update id 1 also resets. The socket sends a 20-second ping and reconnects with bounded exponential backoff.

`singleOpenInterest` is used when present. On older responses where only the documented both-sides `openInterest` sum is available, BCLIF halves it to prevent paired exposure from being counted twice. Trade side is the exchange taker side. Liquidation `S` is interpreted as the liquidated position side under the current all-liquidation contract.
