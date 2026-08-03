# CVD Profile Geometry

## Width metrics

Rows can be sized by Net CVD, Absolute CVD, Buy Volume, Sell Volume, Total Volume, CVD Efficiency, Imbalance Ratio, or the selected calculation engine. Directional color is evaluated independently from normalized width where required.

## Normalization

Available modes include per-profile, per-time-block, rolling, fixed absolute, percentile, robust percentile, logarithmic, and square-root scaling. Robust percentile is the production default because one extreme row should not collapse the rest of the profile.

## Shapes

- **Bidirectional Delta:** negative grows left, positive grows right from the centerline.
- **Absolute + Directional:** absolute magnitude grows from the selected edge; sign controls color.
- **Positive/Negative Split:** sell width and buy width are independently normalized on opposite sides.
- **Mirrored:** equal magnitude is drawn on both sides.
- **Single-Sided Right/Left:** conventional one-edge histogram.
- **Centered:** absolute width expands symmetrically around center.

## Labels and segments

Row labels support Always, Auto, Strong Only, Hover, and Off. Values retain units: signed CVD, compact volume, percentages for efficiency/imbalance, or the selected engine format.

Time Segments Off produces one coherent profile. Stacked, Latest N, Session Blocks, and Custom retain selected time contributions *inside each horizontal profile row*. They never turn the renderer back into chart-wide footprint cells.
