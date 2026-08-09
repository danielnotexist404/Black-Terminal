# BCLIF public live-capture replay

`npm run capture:bclif-public-replay` is a bounded, read-only public replay
harness. It requests 2 hours by default (configurable from 2–6 hours), consumes
the same Bybit bootstrap adapter as production, builds twice on one explicit
absolute grid, and requires identical model and raw-exposure hashes.

The capture is deliberately truthful:

- OI and public price-derived entry evidence are measured;
- unavailable historical trade, all-liquidation, and L2 coverage remain zero;
- no private endpoint, credential, account data, or execution API is used;
- output reports requested/available timestamps, coverage, model/exposure
  hashes, grid contract, authority, frame count, and limitations.

## 2026-08-09 certified capture

The bounded public capture completed successfully after the native Node harness
was made compatible with Vite's Tauri-only transport boundary.

- decision: PASS
- venue / symbol: BYBIT / BTCUSDT
- requested window: 2 hours
- captured frames: 24 five-minute observations
- requested range: `1786273126038..1786280326038`
- observed range: `1786273200000..1786280100000`
- open-interest coverage: 100%
- historical trade / liquidation / order-book coverage: 0% / 0% / 0%
- model hash: `fnv1a-59ef9777`
- raw exposure hash: `fnv1a-bc049a0e`
- authority: `BROWSER_FALLBACK`
- grid: 384 rows, 500 quote-price step, `12000..203500`
- raw shelves in this capture window: 0

The zero-shelf result is not converted into synthetic liquidity. It means this
particular two-hour public window supplied no completed positive OI event family
under the V6 materiality/window contract. The capture proves deterministic live
transport, absolute-grid construction, and honest coverage reporting; it does
not claim unavailable historical trade, liquidation, or L2 evidence.
