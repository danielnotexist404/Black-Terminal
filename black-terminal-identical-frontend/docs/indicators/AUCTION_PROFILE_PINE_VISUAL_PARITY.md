# Auction Profile Pine Visual Parity

> **Shape correction:** the chart-wide grid described in the historical section below is now classified and preserved as CVD Footprint. Original Pine Profile compatibility uses horizontally stacked contributions *inside aggregate price rows*; see `PINE_SEGMENTED_PROFILE_RENDERER.md`.

## Restored visual semantics

The compatibility target is the supplied grid-like screenshot: discrete columns through time, price-row rectangles, per-cell numbers, red negative cells, gray/white positive cells, a developing final column, and restrained POC/VA/IB lines.

BC-MEAP 2.0 restores that topology. Compatibility mode uses:

- Session scope unless Fixed Start is explicitly selected;
- original lower-timeframe directional allocation;
- source block cadence;
- source-compatible signed value formatting;
- developing-global color scaling;
- Dynamic Blocks preset with values enabled.

## Golden status

The native deterministic fixture is certified:

```text
09:00 / 63,000 = +3
09:00 / 63,050 = -4
09:01 / 63,100 = +6
```

It also proves multiple trades in one cell, separate price cells in one block, new block creation, finalized history, incremental current-cell updates, and red/white palette endpoints.

Pine formula and lifecycle compatibility is implemented, but pixel-identical TradingView certification remains pending a synchronized export from the same venue, symbol, timeframe, history range, and script settings. The supplied photograph establishes topology, not a machine-readable cell-by-cell golden dataset.

## Intentional native differences

Native mode corrects Pine's row overwrite behavior, uses canonical aggressor-side trades, avoids duplicate labels, reports exact/mixed/approximate provenance, freezes incremental historical normalization by default, and supports much larger deterministic matrices.
