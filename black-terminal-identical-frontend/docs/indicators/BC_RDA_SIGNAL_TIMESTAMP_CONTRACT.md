# BC-RDA Signal Timestamp Contract

Every Causal V2 signal carries explicit lifecycle time fields.

| Field | Contract |
|---|---|
| `candidateTimestamp` / `candidateIndex` | Closed bar where the condition first became possible: drawdown-threshold entry for Long, or full recovery/upper-extreme arming for Short. Immutable for that candidate. |
| `confirmationTimestamp` / `confirmationIndex` | Closed bar where sufficient causal recovery evidence first exists. Immutable after emission. |
| `time` / `index` | Equal to confirmation timestamp/index for every final signal. This is where the filled dot renders. |
| `displayAnchorTimestamp` / `displayAnchorIndex` | Latest analytical trough (Long) or upper extreme (Short) observed before confirmation. It may move only while developing and is never an order or alert time. |
| `executionEligibleTimestamp` | Confirmation bar close: `confirmationTimestamp + timeframeSeconds`. Never earlier. |
| `confirmationDelayBars` | `confirmationIndex - displayAnchorIndex`; the exact delay from the plotted analytical anchor to the actionable confirmation marker. |
| `lifecycle` | `DEVELOPING` for a hollow provisional candidate; `FINAL` for immutable source output. |
| `finalized` | `false` for developing, `true` for final. |

Stable final identity is:

`bc-rda-causal-v2:{exchange}:{symbol}:{timeframe}:{confirmationTimestamp}:{direction}:final`

Signals are generated only from the finalized input length. When `lastBarConfirmed=false`, the last candle is excluded from the state machine. Repeated ticks within that open candle cannot emit a final signal.

Current policy is stricter than the timestamp contract: `BC_RDA_ALERTS_ELIGIBLE=false` and `BC_RDA_STRATEGY_ELIGIBLE=false` in `src/modules/dda-pro/core/certification.ts`.
