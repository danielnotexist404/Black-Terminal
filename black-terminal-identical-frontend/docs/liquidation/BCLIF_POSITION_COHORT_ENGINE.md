# BCLIF Position Cohort Engine

For a material positive OI interval, BCLIF creates equal paired long and short hypotheses because aggregate OI is not directional. Observed aggressor flow is contextual only; it does not turn OI into a net directional claim. Each cohort stores the exact OI interval, content-hashed entry distribution, leverage distribution, risk tiers, liquidation distribution, estimated remaining notional, survival, posterior weight, confidence, evidence, lifecycle reason, and state.

Negative OI reduces existing cohorts through `BCLIF_DETERMINISTIC_CLOSURE_ALLOCATION_V1`. Time and volatility produce explicitly accounted decay. A side-appropriate crossing with missing event coverage produces one conservative unresolved transition; it is not treated as a confirmed liquidation. Observed events remove vulnerable notional by side/price likelihood and retain immutable historical columns. Capacity expiry is recorded rather than silently pruned.

The browser and persistent collector import the same engine. Its schema-2 export also includes the OI materiality history, model configuration, lifecycle events, and mass ledger; validated import rejects schema/model/source/preset mismatch, malformed relationships, and non-finite state. Only the collector may publish that state as an authoritative private checkpoint.
