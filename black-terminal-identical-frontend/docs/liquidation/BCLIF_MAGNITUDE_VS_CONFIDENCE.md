# BCLIF Magnitude Versus Confidence

Exposure magnitude and evidence confidence are independent contracts.

- Magnitude selects the thermal LUT coordinate.
- Confidence is retained in its own texture and diagnostics.
- Validity decides whether a cell is data or `NO DATA`.
- Explicit visibility settings decide whether a channel is intentionally hidden.
- Cluster-label thresholds never affect the scalar magnitude.

Reference Relative mode never multiplies magnitude by confidence and never hides moderate-confidence exposure by default. Confidence changes only the bounded alpha/desaturation treatment. The renderer contract test replaces every confidence byte while requiring identical Reference Relative scalar intensity.

Verified Authority is deliberately different: non-eligible cells cannot use the extreme yellow endpoint, and low-confidence color is subtly desaturated. That conservative presentation must not be used as proof of reference-style fidelity.

All labels use “estimated relative exposure.” Public OI and browser-session evidence cannot identify account leverage, collateral, hedge state, cross-margin equity, voluntary exits, or exact inventory. Visual strength is decision support, not predictive or liquidation certainty.
