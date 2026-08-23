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

`CHART SYNC` is the default. The ladder measures the chart host's DOM origin and extends the active chart's authoritative price transform through the taller dock. Every price shared by the chart and ladder therefore occupies the exact same screen Y coordinate, allowing direct confluence checks between resting depth and chart structures such as HDLX LVN/HVN levels. Panning, zooming, logarithmic scaling, and panel resizing reproject the ladder without changing those shared coordinates.

`26K OVERVIEW` remains an optional moving USD 26,000 scale and `BOOK FIT` remains an optional fit to the currently delivered consolidated coverage. The overview is intentionally independent and is not a confluence mode. `LOCKED` freezes whichever scale is selected while genuine depth updates continue. Changing symbol or chart identity clears the lock. The v3 workspace preference starts in `CHART SYNC`, deliberately retiring persisted v2 `26K` selections so existing workspaces cannot remain accidentally detached after this correction.

The data projection uses a canonical zero-anchored price grid with a stable nice-number step. A chart pan can reveal different canonical prices at the top or bottom, but it cannot redefine an existing bucket's price bounds, merge the same resting order into a different arbitrary screen row, or renormalize a node from only the visible subset. A zoom or explicit aggregation change may select a different canonical step because the requested analytical resolution has genuinely changed. Aggregation now follows a square-root density curve across 24-220 rows; the old 80-row hard floor no longer makes the 20x, 50x and 100x choices effectively identical.

Shelf length, node brightness and node height use side-specific adaptive significance rather than raw square-root scaling against a shared p95. Each side derives a noise floor from its 85th percentile and a high-depth reference from its 99th percentile. Ordinary levels remain available in the numeric columns and cumulative curve but render only as faint audit traces; statistically meaningful resting levels retain the long neon shelves. This is visual normalization only—no reported quantity is filtered or rewritten.

## Rendering and update cadence

The API projects genuine venue levels into at most 240 globally anchored price bins. Reconciliation matches prior rows by canonical price rather than transient array position. The browser requests a new viewport frame at a bounded cadence and animates genuine snapshot changes with `requestAnimationFrame`. Network polling is not performed at 60 requests per second. The display can render at the monitor refresh rate while the authoritative network cadence stays bounded.

The canvas renders:

- blood-red ask shelves and neon nodes;
- silver/white bid shelves and neon nodes;
- cumulative V-shaped bid and ask depth bands;
- size, signed size, snapshot delta, price, and cumulative depth columns;
- venue count, source depth, observed coverage, and degraded/fallback state.

During a temporary consolidated-feed failure, the last verified frame is marked degraded and retained. If no consolidated frame has ever succeeded, the ladder remains in an explicit `CLF INITIALIZING` or error state. It never falls back to the chart-selected exchange and never changes its source identity when the user changes the chart venue.

The chart exchange selector controls the candles and chart price context only. The chart-docked ladder is always sourced from the Consolidated Liquidity Fabric for the selected base asset, combining every healthy supported venue regardless of which exchange is selected in the terminal header.
