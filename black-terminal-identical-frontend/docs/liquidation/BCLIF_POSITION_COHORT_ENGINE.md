# BCLIF Position Cohort Engine

For positive OI delta, BCLIF creates paired long and short hypotheses because aggregate OI is not directional. Observed aggressor flow only adjusts relative vulnerability and entry uncertainty; it does not turn OI into a net directional claim. Each cohort stores entry distribution, leverage distribution, risk tiers, liquidation distribution, estimated remaining notional, survival, posterior weight and state.

Negative OI reduces existing cohorts probabilistically. Time and volatility decay survival. Price traversal through a liquidation distribution marks partial liquidation. Confirmed events remove vulnerable notional according to price likelihood. Cohorts are bounded and pruned by remaining notional × survival.
