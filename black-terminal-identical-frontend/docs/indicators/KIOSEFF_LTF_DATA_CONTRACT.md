# Kioseff Lower-Timeframe Data Contract

## Canonical identity

Every run fixes venue, raw/normalized symbol, market kind, chart timeframe, lower timeframe,
authoritative decimal tick size, UTC/session policy, terminal timestamp and settings hash. VAE always
requests ordered 1m data because the Pine `request.security_lower_tf` call is hard-coded to `"1"`;
its timeframe input changes only the volatility scaling baseline.

## Ordering and grouping

Inputs use integer Unix seconds. Normalization records original timestamps and source revision,
rejects millisecond units, sorts once, records duplicate/conflicting/out-of-order observations, and
groups each child into exactly one `floor(childTime / chartSeconds) * chartSeconds` parent bucket.
Stateful processing begins only after validation.

Closed parents require every expected child. The final provisional parent may contain only elapsed
children and is replayed from committed state. Missing historical children, source mismatches,
conflicting revisions or invalid bucket alignment fail the compatibility run.

## Coverage diagnostics

The runtime exposes requested/received intrabars, complete/partial/empty parents, first/last required
and received times, missing intervals, duplicates, out-of-order intervals and the current
provisional child count. `READY` requires full requested history and complete deterministic coverage.

## Fixture contract

`KioseffParityDataset` retains ungrouped `chartBars` and `lowerTimeframeBars`, exact terminal time,
tick-size string and full settings. Its validator rejects empty series, non-second timestamps,
duplicates, non-chronological ordering and bars beyond the terminal time. Golden conversion may then
group the same immutable arrays for both the worker and reference-export process.

## Source restrictions

A Bybit parity fixture may not use Binance fallback history, locally synthesized chart bars or mixed
historical/realtime venues. Browser and Tauri transports may differ only before normalization; their
normalized data hash and final cluster hash must match.
