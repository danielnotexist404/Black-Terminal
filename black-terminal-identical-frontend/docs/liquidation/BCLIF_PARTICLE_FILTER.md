# BCLIF Particle Filter

Particles represent `(side, entry, leverage, margin hypothesis, risk tier, liquidation distribution)`. Weight is a normalized leverage prior; notional is the cohort notional, so exposure uses `notional × weight × survival` exactly once. Confirmed events multiply weights by price likelihood and reduce event-attributed notional. The engine caps active cohorts at 640 and particles at 4,096.

This is a bounded sequential hypothesis filter, not a claim to know individual accounts. Account collateral, cross-margin offsets and hedge topology remain unobservable.
