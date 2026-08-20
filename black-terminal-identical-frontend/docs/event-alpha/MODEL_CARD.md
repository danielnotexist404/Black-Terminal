# Event Alpha model card — v1

## Intended use

Estimate whether a verified crypto economic event retains abnormal return after the market response and realistic costs. The output is research and optional paper execution; it is not a guarantee or standalone live signal.

## Formula summary

- Robust expectation: weighted, winsorized observations around the median; dispersion uses scaled median absolute deviation.
- Quantity surprise: `(actual - expected) / max(abs(expected), epsilon)`.
- Timing surprise: event-time deviation scaled to a bounded 30-day unit.
- Governance probability surprise: realized binary outcome minus the pre-event probability.
- Economic impact: event-family direction × absorption/value-capture magnitude. Token unlocks are structurally signed downside; protocol cash-flow direction is signed by the cash-flow change.
- Expected abnormal response: `signed_impact × 1000 bps`, bounded at ±5,000 bps.
- Remaining alpha: forecast minus benchmark-adjusted realized response, spread, slippage, fees, funding and a confidence-dependent uncertainty penalty.

## Limitations

- v1 has no trained causal model artifact; it is deterministic rules/math with versioned manifests.
- Token unlock absorption is an approximation, not sell-volume prediction.
- No order book, CVD, liquidation or funding feed is inferred when absent.
- Governance and protocol-economics calculation contracts exist, but production adapters remain disabled.
- Missing point-in-time data yields `AMBIGUOUS`/`NO_TRADE`; it is not imputed by an LLM.
- Backtest results depend on historical source availability, tradability, fees, latency and survivorship-complete asset data.
- Application calculations use bounded JavaScript numbers and PostgreSQL `numeric` persistence. They are paper-research calculations, not a certified decimal live-money execution engine.

## Tactical relationship

BC-RDA supplies a fresh, direction-matching setup identity only. It cannot create, reverse, extend or revive an Event Alpha thesis. Duplicate setup identities and cooldown violations are rejected.
