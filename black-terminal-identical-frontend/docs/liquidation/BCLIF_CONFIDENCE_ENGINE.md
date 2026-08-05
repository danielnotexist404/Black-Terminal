# BCLIF Confidence Engine

Frame confidence is `18% trades + 24% OI + 15% entry + 12% leverage + 12% margin + 9% confirmed events + 10% continuity`, after mapping certainty classes to scores. Penalties enumerate missing trade-at-price history, confirmed-event history, book absorption and cross-margin collateral.

Per-cell confidence is stored as an 8-bit channel. Confidence-weighted-log mode multiplies normalized log exposure by that channel. A display floor mutes, rather than fabricates or deletes, low-confidence estimates.
