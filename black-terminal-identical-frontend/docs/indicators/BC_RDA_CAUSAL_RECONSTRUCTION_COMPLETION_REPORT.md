# BC-RDA Causal Reconstruction Completion Report

Date: 2026-08-23

Starting commit: `5304a20`

Final source commit: recorded in the release handoff after commit creation.

Preview deployment: not performed in this source phase; VPS/container mutation requires a separate explicit deployment approval and remains a release gate.

## Completed

- Preserved and named the old behavior `BC_RDA_LEGACY_REPAINTING`.
- Reproduced its moving-trough repaint with a minimal executable fixture.
- Added the separately versioned closed-bar `BC_RDA_CAUSAL_V2` state machine.
- Added candidate, confirmation, display-anchor, execution-eligible timestamps, lifecycle, version, settings hash, and prefix data hash.
- Fixed loaded-length-dependent lookback/warm-up and backward-applied current confidence.
- Made worker append confirmation state authoritative.
- Added visual integrity warnings, explicit model selection, filled final versus hollow developing markers, and snapshot diagnostics.
- Disabled BC-RDA alerts, Alert Center enablement, Strategy Lab discovery, Event Alpha tactical use, server definition acceptance, and worker execution.
- Added an unapplied Supabase migration to pause persisted BC-RDA runtimes and enforce database activation guards.
- Added deterministic prefix, append, stream, reload, checkpoint, open-bar, legacy-reproduction, and CVD-containment tests.
- Added deterministic candidate-versus-confirmation visual evidence at `docs/indicators/BC_RDA_CAUSAL_V2_CANDIDATE_CONFIRMATION.svg`.

## Certification verdict

The Causal V2 browser/source model is prefix-invariant for the recorded Native and Pine Compatibility test matrix. It is suitable for continued chart research. It is not certified for alert delivery, performance promotion, Paper, Bybit Demo, investment-group, or real-funds automation.

## Required results and treatments

1. **Repaint root cause:** the legacy batch episode builder kept a mutable active episode and moved its `troughIndex` when a later deeper bar arrived; legacy event projection then redrew one Long marker at the new trough.
2. **Non-causal operations:** no centered/future-aware operation was found in the Causal V2 runtime path. The prohibited-operation scan and every false-positive/unrelated match are recorded in `BC_RDA_REPAINT_FORENSIC_AUDIT.md`.
3. **Legacy status:** `BC_RDA_LEGACY_REPAINTING`, visible research comparison only; alerts, backtests, statistics, Paper, Demo, group, and live automation blocked.
4. **Invalidated results:** every legacy win rate, profit factor, expectancy, drawdown, top/bottom accuracy, optimization result, marker history, and alert hit rate is `INVALIDATED_REPAINTING_SOURCE`.
5. **Causal version:** `BC_RDA_CAUSAL_V2`; it is a new model and its results cannot be combined with Legacy.
6. **Running peak:** all-history running maximum or `[t-L+1,t]` rolling maximum only.
7. **Percentile bands:** point-in-time trailing distribution `[t-L+1,t]`; p05..p99, mean, sigma, rank, and robust deviation remain immutable after bar close.
8. **Smoothing:** one-sided trailing SMA, recursive EMA/RMA, or none. No centered convolution/filter exists in the signal path.
9. **Peak/trough treatment:** developing analytical anchors may update until confirmation. Long requires causal recovery; Short arms at full recovery/upper extreme and requires later causal rollover. Filled markers render only on confirmation bars.
10. **Cloud fading:** renderer opacity is a fixed function of configured fill intensity and band ordinal. Signal fading/reversal evidence uses only trailing velocity and persistence; it never labels a historic local maximum from future bars.
11. **Candidate/confirmation:** threshold entry or upper-extreme arming is the candidate; latest pre-confirmation trough/high is the display anchor; the immutable trading event is the later final confirmation.
12. **Execution eligibility:** `confirmationTimestamp + timeframeSeconds`; developing candidates always store `null`.
13. **Backpainting:** zero execution markers. An analytical anchor may point backward only as disclosed provenance with exact `confirmationDelayBars`; it is never executable.
14. **Prefix invariance:** 180/180 fixed cases, zero failures.
15. **Random truncation:** 100/100, zero failures.
16. **Future append:** baseline plus +10, +100, and +1,000 bars, zero drift.
17. **Batch/stream parity:** 40/40 source-worker cases.
18. **Replay/live parity:** browser worker history-load and one-bar append paths are identical. Independent persistent VPS/headless parity is not yet implemented, so Strategy eligibility remains blocked.
19. **Reload parity:** 40/40.
20. **Checkpoint parity:** 40/40, including Long recovery and Short rollover state.
21. **Drift:** finalized signals 0; finalized values 0; timestamps 0; backpainted executions 0.
22. **Coverage:** BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT; 5m, 15m, 1h, 4h, 1d; Native and Pine Compatibility; deterministic bull/bear/range/shock/recovery/prolonged-drawdown fixtures.
23. **Visual evidence:** `BC_RDA_CAUSAL_V2_CANDIDATE_CONFIRMATION.png` shows hollow candidate/anchor markers separately from filled confirmation-bar markers.
24. **Measured local cold-fixture runtime:** p50 3.558 ms; p95 6.812 ms; p99 32.054 ms. These are host measurements, not a production latency promise.
25. **Strategy Lab:** BLOCKED. BC-RDA is omitted from the manifest and rejected by client, server, worker, Event Alpha, and the unapplied database containment migration.
26. **CVD:** deferred and forced off by settings migration; no synthetic or genuine CVD filter was added to signal confirmation.
27. **Execution:** BC-RDA alerts, Paper, Bybit Demo, group, and live automation remain disabled. Verification did not place, modify, or cancel an order.

## Deliberately not done

- No VPS, Vercel, Supabase, DNS, container, secret, firewall, or execution-flag change.
- No migration deployment.
- No real or demo broker order.
- No attempt to preserve attractive legacy historical performance statistics.
- No CVD signal filter activation.

## Required before automation can be reconsidered

Implement the same versioned state machine in a durable headless runtime; certify exchange closed-candle semantics, persistent checkpoints, restart/reconnect parity, delayed/out-of-order data handling, idempotent alert delivery, and server-side execution policy; then conduct a separate approval and rollout chapter. Until then, both eligibility constants remain false.
