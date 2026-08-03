# CVD Macro Composite Profile

Macro Composite resolves the requested 500–20,000-bar calculation range once, aggregates all events into stable price rows, and renders one unified distribution. It does not create one profile per candle and does not change when the chart camera moves.

Recommended presets:

- **CVD Macro:** 5,000 bars, bidirectional Net CVD, 30% right-side width, minimal LVN/HVN context.
- **CVD Deep Macro:** 20,000 bars, 36% right-side width, standard structure detail.

The calculation worker caps time blocks at the configured matrix budget for footprint/segmentation support, but aggregate rows conserve the full selected-range quantity. The 20,000-bar/2,029-row benchmark projects the range×price profile in 2.63 ms in the recorded local run; worker calculation and browser frame time are separate measures.

Exact historical CVD still depends on a venue trade archive or Black Cloud persistence. Chart-bar fallback remains visibly approximate.
