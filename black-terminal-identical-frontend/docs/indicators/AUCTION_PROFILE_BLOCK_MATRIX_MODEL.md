# Auction Profile Block Matrix Model

## Canonical topology

`AuctionBlockMatrix` contains stable price rows, deterministic time blocks, and sparse non-empty cells. Rows and blocks are calculation state; viewport clipping is presentation state.

`AuctionBlockCell` records:

- row and block indices;
- price and time bounds;
- raw and normalized values;
- buy, sell, unknown, and total quantities;
- notional and trade count;
- TPO and volatility components;
- sign, data quality, and lifecycle flags.

No zero-value full grid is allocated by default.

## Block resolution

Supported cadence: chart timeframe, 1m, 5m, 15m, 30m, 1h, 4h, 1d, adaptive, and custom minutes. Exact trades and lower-timeframe bars may create sub-chart blocks. Chart-bar-only history cannot claim finer granularity than the chart source. Capacity coarsening is deterministic and uses `maximumTimeBlocks`, not chart width.

## Native allocation

For every classified trade:

```text
row   = floor((price - grid origin) / row size)
block = floor((timestamp - profile start) / block duration)
BUY   => buy += quantity
SELL  => sell += quantity
CVD   = buy - sell
```

One trade contributes to exactly one row and block. Chart or lower-timeframe allocation is used only for uncovered intervals and is labeled approximate. Lower bars that belong to a chart interval with exact trades are excluded, preventing double counting.

## Compatibility allocation

Pine Compatibility retains close-to-close lower-timeframe direction, equal distribution across the lower-bar range, the source's set/overwrite quirk for directional fields, session reset mechanics, and developing-global color behavior. It does not silently substitute the native trade-at-price calculation.

## Incremental path

A weak matrix index resolves `block:row` in constant time. Existing cells mutate in place; the cell array is sorted only when a new sparse cell is created. Global renormalization occurs only when the chosen color lifecycle explicitly requests it.

## Stability

Outside Visible Range and Visible Pixel Adaptive modes, camera movement cannot change:

- row or block count;
- cell values or timestamps;
- grid prices;
- POC, VAH, VAL, or nodes;
- profile and matrix versions.

Completed session snapshots have no developing blocks. The final retained session alone owns the live column.
