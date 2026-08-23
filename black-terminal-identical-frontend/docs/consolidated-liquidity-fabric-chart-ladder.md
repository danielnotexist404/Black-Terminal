# Consolidated Liquidity Fabric — chart ladder

The chart-docked LPP ladder is an informational cross-market view of directly observed public resting liquidity. It does not invent levels outside a venue's delivered book and it is not an execution book.

## Direct sources

- Coinbase Exchange `level2_batch` supplies the full aggregated Level 2 snapshot and live changes. It is the wide-range backbone.
- Binance Spot supplies direct 5,000-level REST snapshots.
- Bybit linear perpetuals use the new full-depth REST snapshot plus sequence-checked `orderbook.full` deltas. The current official contract advertises up to 10,000 snapshot levels per side, while the live response can contain more; the runtime reports the actual received level count rather than promising a fixed count.
- Hyperliquid supplies its direct top-20-per-side `l2Book` stream. It adds nearby perpetual-market confirmation; it is not presented as wide coverage.
- Kraken Spot supplies direct public 500-level REST snapshots.

Every row retains per-venue contributions. USD, USDT, and USDC are combined at display parity and disclosed as such. The chart never claims routeable composite execution, hidden orders, RPI orders, or inferred liquidity.

Official protocol references:

- Coinbase Exchange WebSocket channels: https://docs.cdp.coinbase.com/exchange/websocket-feed/channels
- Coinbase Exchange product book: https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book
- Binance Spot WebSocket streams: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
- Bybit public order book: https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook
- Bybit full-depth snapshot: https://bybit-exchange.github.io/docs/v5/market/full-ob
- Bybit full-depth delta stream: https://bybit-exchange.github.io/docs/v5/websocket/public/full-ob
- Hyperliquid info and `l2Book`: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- Kraken Spot order book: https://docs.kraken.com/api/docs/rest-api/get-order-book/

## Scale behavior

`FOLLOW` is the default. The ladder always consumes the active chart's authoritative price transform, so panning and zooming reprojects the requested market-depth viewport.

`LOCKED` freezes only the current price range. It never replaces the chart scale with the narrow delivered range of one venue. Changing symbol or chart identity returns to `FOLLOW`.

## Rendering and update cadence

The API projects genuine venue levels into 8–240 chart bins. The browser requests a new viewport frame at a bounded cadence and animates genuine snapshot changes with `requestAnimationFrame`. Network polling is not performed at 60 requests per second. The display can render at the monitor refresh rate while the authoritative network cadence stays bounded.

The canvas renders:

- blood-red ask shelves and neon nodes;
- silver/white bid shelves and neon nodes;
- cumulative V-shaped bid and ask depth bands;
- size, signed size, snapshot delta, price, and cumulative depth columns;
- venue count, source depth, observed coverage, and degraded/fallback state.

During a temporary consolidated-feed failure, the last verified frame is marked degraded and ages into stale state. If no consolidated frame has ever succeeded, the existing direct Bybit book is shown explicitly as a degraded fallback rather than being relabelled as multi-venue data.
