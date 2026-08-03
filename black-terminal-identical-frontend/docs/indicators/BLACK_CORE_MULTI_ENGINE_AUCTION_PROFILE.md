# Black Core Multi-Engine Auction Profile

BC-MEAP is a worker-owned, Pixi-rendered auction map. It retains the supplied Pine CVD Profile as a compatibility reference while exposing a separate native engine.

## Pipeline

1. Venue trades enter the canonical CVD service with venue, symbol, timestamp, price, quantity, aggressor side, and classification source.
2. The scope resolver freezes session, rolling, fixed, manual, composite, periodic, or macro boundaries.
3. The deterministic instrument-anchored price grid maps exact trades at price. Bars are used only as an explicitly reported fallback.
4. Engine adapters derive CVD, volume, TPO, activity, USD notional, volatility, trade statistics, or the hybrid score.
5. Value area, POC, LVN/HVN zones, profile version, and data-quality diagnostics are calculated in a versioned Web Worker.
6. Pixi draws bounded geometry and pooled text without React cells.

Native profiles support 20,000 chart bars. Except for explicitly selected Visible Range or pixel-adaptive sizing, chart panning and zooming do not alter the calculation.

## BC-MEAP 2.0 matrix layer

The canonical snapshot now carries both:

- aggregate `rows` for value area, POC, nodes, and optional histogram presentation;
- a sparse `matrix` for discrete time-by-price evidence.

Native trades allocate at exact trade price and time. Pine Compatibility retains its lower-timeframe distributed model. Session calculation returns every retained session snapshot, finalizes completed matrices, and leaves only the latest session developing.

The display default is Dynamic Blocks + Key Levels. Scope and presentation are independent, so Macro Composite can remain a block matrix and Session may intentionally use the aggregate view.
