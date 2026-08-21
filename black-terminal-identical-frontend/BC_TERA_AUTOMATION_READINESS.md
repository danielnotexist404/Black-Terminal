# BC-TERA Automation Readiness

Current stage: **A — Research Indicator**

| Gate | State |
|---|---|
| Causal calculations | Implemented and deterministically tested |
| Evidence diagnostics | Implemented |
| Marker/event identity | Implemented |
| Alerts certified | No |
| 90-day forward observation | Not started |
| Shadow strategy | Not implemented |
| Paper execution | Not implemented |
| Restricted live pilot | Not authorized |
| Live execution | Locked |

BC-TERA contains no order submission, modification, cancellation, position sizing, execution ticket, broker credential, mandate, Investment Group, or Black Cloud path. UI alerts are research notifications only. Alert payloads explicitly declare `automationState: RESEARCH_ONLY` and `liveExecutionLocked: true`.

Only `TOP_REVERSAL_CONFIRMED` and `BOTTOM_REVERSAL_CONFIRMED` could become future strategy-entry candidates, and only after separate alert, shadow, paper, execution-quality, risk-control, and forward-observation certification. Extremity, exhaustion, absorption, capitulation, hazard, or data-degraded events are never entry instructions.

Advancing stages requires a new chapter and explicit authorization. A later execution integration must fail closed for stale/low-confidence data, unknown model version, ambiguous event ownership, stale account/reconciliation state, excessive spread/slippage, insufficient liquidity, duplicate event ID, missing risk state, failed protective orders, or unavailable Black Cloud fencing.

