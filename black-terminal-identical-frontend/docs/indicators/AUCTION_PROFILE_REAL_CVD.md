# Auction Profile Real CVD

Native CVD uses aggressor-classified public trades at the executed price.

- Bybit maps public-trade `S`, documented as taker side, to BUY/SELL.
- OKX maps the venue trade-side field.
- Binance maps `buyer is market maker`: true means the taker sold, false means the taker bought.
- Uncertified venue semantics are marked INFERRED rather than promoted to exact.

For each row:

`CVD = aggressive buy quantity - aggressive sell quantity`

Unknown side remains a separate accumulator. Exact and inferred quantities are not merged in diagnostics. Closed exact trades are deduplicated by market and trade ID. Live trades update the affected row incrementally; a full 20,000-bar rebuild is not run for every print.

Official venue references: [Bybit public trades](https://bybit-exchange.github.io/docs/v5/websocket/public/trade), [Bybit recent trades](https://bybit-exchange.github.io/docs/v5/market/recent-trade), [Binance trade streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams), and [OKX API](https://www.okx.com/docs-v5/).
