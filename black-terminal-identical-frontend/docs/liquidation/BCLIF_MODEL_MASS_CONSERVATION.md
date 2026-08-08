# BCLIF Model Mass Conservation

For quote-notional model mass:

`created - voluntaryClosure - confirmedLiquidation - decayExpiry = remaining`

`LiquidationCohortEngine` reconciles this identity after every canonical frame, after checkpoint import, and after pruning. The tolerance is `max($0.01, totalCreated × 1e-9)`; exceeding it throws and fails the model build.

Births add equal per-side quote notional. Contraction, observed liquidation, unresolved traversal, decay, and bounded expiry all remove mass through one recorded path before particles are synchronized to cohort survival. Rasterization consumes remaining notional but does not mutate it and no second survival discount is applied.

The invariant suite reports the exact conservation error and asserts the identity after birth, anchoring, contraction, event assimilation, chunk reconstruction, and a full snapshot. The deterministic C3 fixture currently resolves within floating-point tolerance; its golden metadata must remain at or below `0.01`.
