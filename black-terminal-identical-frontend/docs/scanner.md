# BLACK-TERMINAL Market Scanner

The Market Scanner is a multi-symbol, multi-timeframe research module for finding instruments that match technical, price-action, volume, volatility, and trend rules.

## Opening The Scanner

Open the left sidebar and select `SCANNER`. The scanner runs inside the main workspace, beside the existing DOM, order book, and tape panels.

## Running A Scan

1. Choose a preset.
2. Select the universe: current watchlist, all REST-live symbols, selected exchange, or manual symbols.
3. Select one or more timeframes.
4. Review or edit the rules.
5. Press `Run Scan`.

The scan remains cancellable with `Stop`. One failed symbol does not fail the full scan; failures are counted in the toolbar.

## Presets

Built-in presets are read-only and can be duplicated:

- Strong Uptrend
- Breakout With Volume
- Oversold Bounce Candidate
- Bearish Breakdown
- Volatility Expansion
- Relative Strength Leaders

User presets are persisted in `localStorage` under `bt_scanner_presets_v1`. Built-ins are never overwritten.

## Rule Builder

Rules support:

- Price operands: close, volume, range
- Indicators: EMA, RSI, ATR, volume SMA, highest high, lowest low, ROC
- Operators: `>`, `>=`, `<`, `<=`, `crosses_above`, `crosses_below`, `between`, `rising`, `falling`, `near`, `percent_above`, `percent_below`
- Top-level `AND` / `OR` condition groups in the engine

The UI currently edits the top-level group and common operand types. The engine already supports nested condition groups for future advanced UI editing.

## Results

Results include:

- Symbol
- Exchange
- Market
- Timeframe
- Last price
- Change %
- Volume
- Relative volume
- Score
- Matched rules
- Last updated

Use `Open` to load a matching symbol/timeframe on the chart. Use the bell action to create a standard BLACK-TERMINAL price alert at the latest scanner price.

## Scoring

The default score is 0-100:

- Trend alignment: up to 25
- Volume confirmation: up to 20
- Momentum strength: up to 20
- Volatility expansion: up to 15
- Relative strength / ROC: up to 20

The `ScoreCalculator` module is intentionally separated so more institutional scoring can be added without changing the scanner engine.

## Developer API

Core APIs:

- `ScannerEngine.runScan(config, symbols, options)`
- `validateScanConfig(config)`
- `resolveUniverseSymbols(config, currentWatchlist)`
- `sortResults(results, config)`
- `getBuiltInPresets()`
- `getUserPresets()`
- `saveScanPreset(config)`
- `deleteScanPreset(id)`
- `duplicateScanPreset(config)`

Data access is decoupled through `ScannerDataAdapter`. The production adapter is `PublicMarketScannerDataAdapter`, which uses the existing public exchange registry.

## Limitations

- Benchmark-relative strength is scaffolded but benchmark/index feeds are not connected yet.
- Scan alerts currently create result-level price alerts. Full saved-scan alerts can build on the same alert center.
- Realtime scan mode is represented in config; current execution path is manual/interval-ready REST scanning.
- The UI exposes common rule editing. The engine supports richer nested groups than the current first-pass UI.
