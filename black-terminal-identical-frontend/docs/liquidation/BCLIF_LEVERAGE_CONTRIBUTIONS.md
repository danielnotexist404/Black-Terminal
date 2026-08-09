# BCLIF leverage contributions

The venue-calibrated leverage prior remains normalized to unit probability:

| Leverage | Prior |
| ---: | ---: |
| 2x | 5% |
| 3x | 8% |
| 5x | 20% |
| 10x | 28% |
| 25x | 20% |
| 50x | 13% |
| 100x | 6% |

The >=50x tail is therefore 19%, bounded and visible but not dominant by
construction. Every raw shelf export carries the exact leverage distribution.
The 20-cell audit aggregates cohort-weighted contributions at each absolute
price so an intense band can be explained rather than guessed.

Entry, model, and visual widths are separate:

- entry width: the weighted trade/lower-timeframe price distribution;
- model width: liquidation uncertainty from leverage, risk tier, and margin
  mode;
- visual width: optional GPU smoothing, never written back to the model.

Isolated/cross/unknown margin priors conserve one raw unit of modeled mass.
Their default weights are 82%/12%/6%. Raw raster mass is no longer multiplied
by confidence. Confidence and the renderer's historical/low-evidence caps mute
visual authority without deleting or moving uncertain raw mass.
