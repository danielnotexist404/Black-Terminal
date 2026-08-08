# BCLIF Confidence Engine

Frame confidence is `18% trades + 24% OI + 15% entry + 12% leverage + 12% margin + 9% confirmed events + 10% continuity`, after mapping certainty classes to scores. Penalties enumerate missing trade-at-price history, confirmed-event history, book absorption and cross-margin collateral.

Per-cell confidence is stored as an 8-bit channel. Confidence-weighted-log mode applies the confidence weight to exposure before causal log/quantile normalization, preserving supported relative intensity without presenting weak inputs as equally certain. A display floor mutes, rather than fabricates or deletes, low-confidence estimates.

V5 additionally applies evidence-source caps before rasterization: exact trades 95%, lower-timeframe volume-at-price 82%, lower-timeframe approximation 60%, and chart-bar approximation 42%. Missing/unavailable historical trades impose a hard 60% browser cap. Isolated/cross/unknown margin weights are 82%/12%/6%; the broader cross and unknown kernels cannot become high-authority yellow cores. Missing source coverage remains an invalid/unknown region, never a measured zero.
