# BCLIF Data Truth Model

Every input is classified as `OBSERVED`, `DERIVED`, `ESTIMATED_HIGH`, `ESTIMATED_MEDIUM`, `ESTIMATED_LOW`, `SYNTHETIC_TEST`, or `UNAVAILABLE`. Bybit OI, public trades, public order book, risk tiers and all-liquidation messages are observed. Volatility and basis calculated from observed prices are derived. Entry allocation, leverage, margin mode and unknown account collateral are estimates.

Missing intervals are invalid cells, not zeros. Low confidence mutes intensity while preserving a visible purple field; tooltips/diagnostics retain certainty and coverage. Synthetic fixtures are developer-only and unmistakably labeled.
