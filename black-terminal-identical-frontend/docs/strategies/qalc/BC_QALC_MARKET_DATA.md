# BC-QALC Market Data

`QalcBybitGateway` opens one Bybit linear public WebSocket and multiplexes `orderbook.200.<symbol>` and `publicTrade.<symbol>`. It preserves exchange milliseconds, local receive/process milliseconds, update id, cross sequence, matching-engine timestamp where supplied, trade id, aggressor side, block-trade and RPI flags.

Instrument metadata is loaded from `/v5/market/instruments-info`, converted into a versioned `INSTRUMENT` event and refreshed every six hours. Tick size, quantity step, quantity limits, minimum notional, funding interval and contract status are not assumed permanent.

No candle direction or synthetic buy/sell volume enters the feature engine. Browser DOM feeds are not a runtime dependency and no browser-local fallback exists.

The baseline archives L200 input and calculates depth features through L50. Ticker/funding capture is a documented remaining extension.
