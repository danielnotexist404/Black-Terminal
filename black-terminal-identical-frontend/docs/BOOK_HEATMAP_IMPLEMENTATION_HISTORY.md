# Book Heatmap Implementation History

## 2026-07-22 - Truthful main-chart Book Heatmap rebuild

Status: Implemented and release-certified; production deployment is verified after the release commit.

### Replaced

- Removed the prior main-chart projected/warming behavior that extended the newest book backward over candles.
- Replaced the narrow, shallow snapshot presentation with a time-price liquidity matrix that stores only observed live frames and authenticated historical tiles.
- Removed forced Book Heatmap and Volume defaults while preserving explicit user workspace visibility through schema-version-2 migration.

### Added

- Dedicated Book Heatmap worker, transferable typed compaction, latest-wins per-venue backpressure and deterministic fallback.
- Base-quantity certification and quote-notional conversion before aggregation.
- Per-venue integrity state, freshness, latency, source sequence/time, rejection counters and consolidated venue contributions.
- Bounded live/history/trade/event memory and wide-view LOD.
- Stacking, pulling, persistence, imbalance, replenishment, spoof-risk, absorption, iceberg and estimated consumed/cancelled analytics with confidence and input disclosure.
- Authenticated Black Core historical-tile client with trusted-source enforcement and honest unavailable/empty states.
- Fullscreen workspace with Live Book, Estimated Liquidations and Confirmed Liquidations modes.
- Public Bybit and Binance confirmed-liquidation parsers/subscriptions with reconnect and teardown.
- Blood-red, orange and silver-white robustly normalized raster; opacity, smoothing, threshold, palette, range, horizon and venue controls.
- Recorded public exchange fixtures, deterministic model/camera/liquidation tests, performance/soak harness and 12-state visual regression suite.
- Added a truthful right-edge current-depth profile so authentic live L2 is immediately readable on 1H/4H charts even before historical coverage exists; observed time columns are still never projected backward.
- Localhost-only visual fixture hook. It is unavailable on production hostnames and cannot introduce mock data into normal runtime paths.

### Measured evidence

The final bounded 50,000-snapshot soak before publication processed 200 bid and 200 ask levels per observation in 4,941.69 ms, retained exactly 600 live frames, produced 3,177 visible cells and retained 16.62 MB of additional heap. Observed throughput was 10,118 snapshots/second at 0.0988 ms per snapshot on the development machine; visible-cell construction took 41.72 ms. The separate 12,000-snapshot performance run measured 10,715.5 snapshots/second, 0.0933 ms per snapshot, 49.11 ms cell construction and 13.51 MB heap delta. These values are machine-specific; the executable assertions, not the numbers alone, are the regression gate.

The production build passed TypeScript, 27 security route contracts, Vite bundling and a scan of 19 production assets for provider secrets. The visual suite captured all 12 states, including a fresh 1H session with no historical cells, with zero application runtime/console errors, zero forbidden third-party requests and Volume still disabled.

### Provenance boundary

- Live Book is authentic normalized L2 only.
- Estimated Liquidations are model-derived and visibly labeled.
- Confirmed Liquidations are separate public exchange events.
- Missing history is empty and reported.
- No Coinglass code/assets/data and no `perpdexwars.com` runtime dependency are included.

### DOM Pro+ boundary

No DOM Pro+ source, worker, camera, state, styling, preset, test, documentation or shared venue-adapter file was changed. Binance sequence-aware reconstruction is isolated in the Book Heatmap module. DOM Pro+ is validated only through its existing regression commands.

### Remaining

- Historical coverage depends on the running Black Core collector and retained authenticated tiles.
- OKX contract multipliers remain uncertified for this matrix.
- Estimated Liquidations still need synchronized open-interest and funding history.
- Confirmed events are browser-session bounded and not yet persisted.
- L2 consumed-versus-cancelled attribution remains an explicitly labeled estimate.
