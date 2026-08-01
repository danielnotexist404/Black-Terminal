# Kioseff Golden-Master Protocol

## Rule

Never generate expected output from Black Terminal and label it TradingView. A certified fixture must
contain a real TradingView export and the exact immutable market-data/settings identity used by both
runs. Empty references remain `pending-reference`.

## Required matrix

- Bybit BTCUSDT perpetual: 1H lower, 4H lower, 1H higher.
- Bybit ETHUSDT perpetual: 1H lower.
- Bybit BTCUSDT perpetual: 1H Absorbtion Extremes with current-bar revisions.
- Historical triggers on/off.
- Active cluster size on.
- At least one provisional-bar revision sequence.

Each row records venue, symbol, market kind, chart/LTF, terminal timestamp, tick size, settings hash,
data hash, engine/source version and complete coverage diagnostics.

Pending manifest rows carry null terminal/data identity fields until the external captures exist;
approval requires replacing every null identity/coverage field with verified values.

## Golden cluster fields

For every active and historical cluster export side, price low/high/reference, start/end, state,
signed and absolute volume, percentile value, normalized strength, hot flag, label text, granularity,
creation/violation bar indices and normalized color/alpha.

## Evaluation

1. Validate data contract and 100% LTF coverage.
2. Clean-rebuild the worker and compare every bar snapshot/current revision.
3. Report the first exact integer/state difference or tolerance-bounded float difference.
4. Compare clean rebuild, streamed replay, cached replay and browser/Tauri hashes.
5. Only after numeric pass, capture synchronized TradingView and Black Terminal images using identical
   time and price ranges.
6. Generate a difference overlay marking missing, extra, shifted, resized, recolored and unlabeled
   geometry.

## Approval

All material rows must pass. The engine version must continue to include `parity-pending` and Black
Core Enhanced must remain disabled until the approved golden files exist under
`tests/golden/kioseff/` and the full matrix passes.
