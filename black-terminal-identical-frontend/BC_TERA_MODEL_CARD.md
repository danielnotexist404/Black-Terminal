# BC-TERA Model Card

Model: `bc-tera-phase1-1.0.0`  
Feature schema: `bc-tera-feature-v1`  
Automation state: `RESEARCH_ONLY`  
Live execution: locked

## Intended use

BC-TERA is a higher-timeframe research indicator for exploring terminal extremity, marginal-impact exhaustion, absorption, leverage fragility, distribution/capitulation, and causal reversal confirmation. Its score is diagnostic evidence, not a trade instruction.

## Prohibited use

Do not use BC-TERA as a guarantee of a top/bottom, a wick predictor, autonomous parameter optimizer, position-sizing authority, broker trigger, group-copy authority, or live execution strategy. No real-order authorization exists.

## Supported and unsupported assets

The contract supports `BTC_FULL`, `ETH_FULL`, `TRANSPARENT_CHAIN`, `DERIVATIVES_AND_SPOT`, `SPOT_ONLY`, `LIMITED`, and `UNAVAILABLE` profiles. Full profiles are data contracts, not a statement that the current deployment has full coverage. Phase I's live chart adapter is `SPOT_ONLY`.

Privacy assets and any asset without transparent cost-basis data cannot receive fabricated MVRV/SOPR evidence. Options, valuation, or derivative components remain null when unavailable.

## Feature definitions

- Valuation: provider-normalized causal extremity, holder distribution, realized profit/loss.
- Leverage: OI intensity, OI change, funding crowding, annualized basis, leverage reset, liquidation shocks.
- Exhaustion: aggressive directional flow plus collapse in directional price impact; trade confirmation is mandatory.
- Absorption: exhausted directional trade flow plus opposite-side replenishment/rejection confirmed by trades.
- Distribution/capitulation: separate weighted evidence families; neither is a confirmation alone.
- Change point: causal directional CUSUM on robustly standardized confirmed-bar returns in Phase I.
- Hazard: separate fixed logistic top and bottom models, multiplied by evidence-coverage confidence.
- Confidence: requested-family availability/quality plus multi-venue agreement penalty.

Provider inputs are normalized to 0–100 before the Phase-I model. Missing values remain null. Quality affects confidence and therefore hazard coverage.

The feature, regime, robust-Z, flow, and impact lookbacks define causal provider/normalizer contracts. Phase I's chart adapter can apply only the market/regime subset because it intentionally does not synthesize the absent evidence families. The hazard horizon and confirmation timeframe are recorded research parameters; the Phase-I shell evaluates one decision-bar stream and makes no calibrated horizon claim.

## Training and validation periods

No historical training dataset is connected in Phase I. Training period: none. Validation period: none. Final holdout: untouched/not yet defined. Leave-one-cycle-out partitions: not yet defined. The Phase-I coefficients are documented research priors, not fitted coefficients.

Parameter trials recorded: **0 historical optimization trials**. Deterministic engineering fixtures are tests, not parameter searches.

## Calibration

Empirical Brier score, reliability curve, precision/recall, lead time, false-extremity rate, and Deflated Sharpe Ratio are unavailable because no certified historical feature/label dataset exists. The only Phase-I hazard gate verifies bounds and monotonicity under complete deterministic evidence. UI values must not be interpreted as calibrated probabilities until Phase II reports calibration.

## Label construction for Phase II

Offline labels will use volatility-scaled first passage: a top label is positive if the downside reversal barrier is reached before the upside continuation barrier within horizon H; bottom labels mirror the direction. Label version, barrier parameters, volatility-estimator version, horizon, symbol, timeframe, and dataset cutoff must be stored. Future data may create labels only; it may never enter live features.

## Known limitations

- Phase I live coverage is price-only and therefore normally degraded.
- CUSUM responds to standardized return shifts; multi-feature change-point inputs await Phase II.
- Hazard coefficients are uncalibrated research priors.
- No options, on-chain, stablecoin, or BC-TERA-specific multi-venue historical ingestion exists.
- No historical performance or trading profitability claim is available.
- Browser-local candle history can be shorter than the configured decision-feature lookback.
