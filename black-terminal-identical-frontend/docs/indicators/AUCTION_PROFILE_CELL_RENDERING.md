# Auction Profile Cell Rendering

The renderer uses one batched Pixi `Graphics` stream for matrix quads and a stable, keyed Pixi text pool. Unchanged labels retain their text objects and textures across live frames; removed labels return to the pool. It does not create React cells or a Graphics object per cell.

## Geometry

Each cell projects:

```text
x = block start → block end
y = price high → price low
```

The shared chart time and price transforms keep cells synchronized with candles under pan, zoom, resize, linear/log scale changes, and future-edge extrapolation.

## Palette

- positive near zero: `#202020`;
- positive extreme: configured silver-white, default `#e2e3e5`;
- negative near zero: `#2a0508`;
- negative extreme: configured blood red, default `#ec182a`;
- neutral: default `#333333`;
- borders: near-black `#090909`.

Continuous interpolation uses normalized magnitude. Brightness and opacity are presentation-only.

## Labels

Cell Text supports Always, Auto, Hover Only, Strong Cells Only, and Off. Text sizes support Auto/Tiny/Small/Normal/Large/Huge. Auto uses cell pixel geometry, compact signed units, stable centered alignment, and a global label budget.

Hover inspection remains available regardless of label mode and reports time bounds, price bounds, engine, raw value, buy/sell/total quantity, CVD, notional, trade count, source quality, and finalized/developing state.

## Capacity

The full sparse matrix remains in the worker snapshot. The renderer culls off-camera cells and applies deterministic display-only strides when visible columns or rows exceed their budgets. Signed CVD and additive fields are summed rather than averaged. This never converts the matrix into a histogram.

Volatility components are retained on cells for estimator-aware evolution. TPO render downsampling currently sums bracket counts because finalized cells do not yet retain bracket identity; exact unique-bracket merging is a documented remaining refinement.
