# Auction Profile Shape Restoration

## Corrected product boundary

The Auction Profile is a **selected-range × price** distribution, but its body is not a solid bar. Each price row is a chronological chain of compact CVD matrix blocks. The number and magnitude of real contributions form the row width; the rows together form the HDLX-style silhouette.

Each visible block retains two truthful values:

- signed delta contributed by the source time bucket(s);
- developing cumulative CVD for that price row at the end of the block.

The reference-faithful default prints developing CVD in the block. `Block Delta` is an optional non-cumulative view. Deterministic display compression groups adjacent chronological cells only when the pixel budget requires it, sums their deltas, keeps the final cumulative value, and reports the source-cell count on hover. It never repeats a fabricated number.

This remains different from the separate **CVD Footprint** chart type. Profile blocks are packed from the calculation-range anchor to build a price-distribution silhouette; footprint cells stay aligned to their original candle time on the chart.

## Default topology

The default is Auction Profile → HDLX CVD Matrix Blocks → Single-Sided Right → Range Start → CVD Activity. Selling pressure is independently graded from dark red to blood red. Buying pressure is independently graded from dark graphite through silver to white. Every block receives its own color from its own signed CVD value.

The default 48% width, 24-pixel cells, and 72-row grid keep the full 5,000-bar profile legible with values inside the cells. The same renderer supports 10,000 and 20,000 bars without changing the calculation when the camera moves. Solid Histogram remains an explicit optional construction, not the default.

## Scope semantics

- Session: one developing/finalized block profile per session.
- Fixed Start: one profile from the selected start through the developing edge.
- Rolling/Manual: one profile for the selected bar range.
- Composite/Periodic/Macro: one profile per resolved composite range.

Camera movement does not alter calculation data except when Visible Range or Visible Pixel Adaptive is explicitly selected. When the selected range begins off camera, Range Start pins the already-calculated profile to the left plot edge instead of recomputing it.

## Structure and live behavior

POC, VAH, VAL, IB, LVN, and HVN remain constrained to the profile boundary. Classified live trades update only their active price/time cell; the block's delta and developing row CVD update together while finalized history remains frozen.

## Certification

`npm run test:auction-profile` certifies signed matrix conservation, cumulative row CVD, deterministic chronological compression, source-cell disclosure, stable placement, live updates, renderer separation, and exact/mixed provenance. `npm run benchmark:auction-profile` covers 100 through 20,000 bars.
