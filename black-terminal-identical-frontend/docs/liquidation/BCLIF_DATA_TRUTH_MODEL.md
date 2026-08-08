# BCLIF Data Truth Model

Every input is classified as `OBSERVED`, `DERIVED`, `ESTIMATED_HIGH`, `ESTIMATED_MEDIUM`, `ESTIMATED_LOW`, `MISSING`, `SYNTHETIC_TEST`, or `UNAVAILABLE`. Bybit OI, public trades, reconstructed public order book, risk tiers, and all-liquidation messages are observed only over their measured source intervals. Volatility and basis calculated from observed prices are derived. Entry allocation, leverage, margin mode, and unknown account collateral remain estimates.

Missing intervals are invalid cells, not zeros. Every snapshot also declares exactly one authority: persistent node, browser fallback, replay, or test fixture. Low confidence mutes intensity while preserving a visible purple field; tooltips/diagnostics retain certainty and coverage. Synthetic fixtures are developer-only, local/test-gated, and unmistakably labeled.
