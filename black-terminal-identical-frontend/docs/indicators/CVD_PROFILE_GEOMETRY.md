# CVD Profile Geometry

## Block-built profile

`HDLX CVD Matrix Blocks` is the production default. For each price row, Black Core orders the selected lookback's sparse matrix cells chronologically and calculates the developing row CVD. Compact cells are then packed horizontally from the calculation-range anchor. Their chain is the profile body—not a footprint and not a solid histogram overlay.

Blocks display Developing CVD by default, matching the supplied reference construction. Block Delta is available when a non-cumulative read is preferred. Red/blood-red means negative CVD; graphite/silver/white means positive CVD. Color intensity is normalized independently from profile width.

## Width metrics

CVD Activity (`Σ|delta|`) is the default width metric because opposing flows must not cancel the physical profile shape. Net CVD, Absolute CVD, Buy Volume, Sell Volume, Total Volume, CVD Efficiency, Imbalance Ratio, and the selected calculation engine remain optional alternatives.

## Placement and shapes

Left is the default side. It anchors the block chain at the selected 5K/10K/20K calculation origin and pins it to the left edge only when that origin is off camera. Right mirrors the matrix at the latest edge. The dedicated Profile Length control contracts or stretches the matrix body without changing its data, range anchor, or historical structural extensions.

Single-Sided Right is the reference geometry. Bidirectional Delta, Absolute + Directional, Positive/Negative Split, Mirrored, Single-Sided Left, and Centered remain available for research views.

## Resolution and labels

Block Width controls the visible matrix-cell size. When a row contains more history than fits, adjacent chronological source cells are compressed deterministically. Signed delta is conserved and the final developing CVD is retained. Cell labels follow Always, Auto, Strong Only, Hover Only, and Off policies; aggregate row labels are disabled in the block-built default.

## Structural overlay

The matrix profile is frameless. POC, VAH, VAL, and the small set of significant hollow LVN/HVN zones span the entire selected calculation range rather than stopping at the profile body. POC uses the configurable thicker neon color; VAH/VAL use a configurable continuous neon color. The background between VAH and VAL has independent color and intensity controls and may be disabled with zero intensity.
