# BCLIF Particle Filter

Particles represent `(cohort ID, side, interval entry row, leverage, margin hypothesis, risk tier, liquidation distribution)`. Their weight is `entry weight × leverage probability × margin contribution`; weights are normalized per cohort. Notional is synchronized from remaining cohort notional, so exposure uses `notional × weight × confidence` exactly once. Cohort survival has already reduced remaining notional and is not applied a second time. Confirmed events use price likelihood to reduce attributable mass and update the posterior without moving the particle's liquidation anchor.

The V5 engine caps active cohorts at 320 and particles at 24,576. Default margin contributions conserve unit weight: 0.82 isolated, 0.12 cross, and 0.06 unknown. Cross/unknown distributions are wider and lower-confidence; their cap cannot be bypassed by presentation settings. The regime-adaptive V2 prior includes explicit 5x, 10x, and 20x buckets plus lower/higher tails.

This is a bounded sequential hypothesis filter, not a claim to know individual accounts. Account collateral, cross-margin offsets and hedge topology remain unobservable.
