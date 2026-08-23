# BC-RDA No-Repaint Certification

Certification date: 2026-08-23

Model: `BC_RDA_CAUSAL_V2`

Result: source calculation PASS; alerts/automation BLOCKED.

## Results

| Test | Cases | Drift/failures |
|---|---:|---:|
| Market × timeframe × engine fixed prefixes | 180 | 0 |
| Deterministic random truncations | 100 | 0 |
| Future append horizons | 4 | 0 |
| Worker batch/stream parity | 40 | 0 |
| Reload parity | 40 | 0 |
| Checkpoint parity | 40 | 0 |
| Finalized signal drift | — | 0 |
| Finalized value drift | — | 0 |
| Signal timestamp drift | — | 0 |
| Backpainted execution timestamps | — | 0 |

The harness emits current p50/p95/p99 cold full-fixture timings for the local host. These are engineering measurements, not fixed production latency guarantees.

## Additional gates

- The last open bar is excluded from final signal production.
- Developing candidates have `executionEligibleTimestamp=null`.
- Final marker index equals confirmation index.
- CVD confirmation is forced off pending independent genuine-CVD validation.
- Alert stream is empty under every signal mode.
- Strategy Lab selection and server execution boundaries reject BC-RDA.
- No automated test places, modifies, or cancels any broker order.

## Command

`npm run test:dda-pro-no-repaint`

The emitted JSON is the authoritative machine-readable result for the checked-out source. Any model/settings/timestamp change requires rerunning the entire harness and updating this document. Source certification alone cannot set either execution eligibility constant to true.

## Candidate/confirmation visual evidence

[`BC_RDA_CAUSAL_V2_CANDIDATE_CONFIRMATION.png`](./BC_RDA_CAUSAL_V2_CANDIDATE_CONFIRMATION.png) (source: [`SVG`](./BC_RDA_CAUSAL_V2_CANDIDATE_CONFIRMATION.svg)) renders the deterministic seven-bar lifecycle fixture asserted by the harness: hollow Long trough and Short upper-extreme anchors remain analytical/developing, while filled markers are placed only at their later closed-bar recovery/rollover confirmations.
