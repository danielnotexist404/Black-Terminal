# BC-TERA Validation Report

Phase: I deterministic engineering validation. This is not historical model certification.

## Executed gates

`npm run test:bc-tera-all` executes 33 deterministic checks, including all 20 required fixtures:

1. blow-off top with leverage;
2. strong bull continuation;
3. high MVRV continuation;
4. buy-flow absorption;
5. bearish change point after distribution;
6. flash crash without lasting bottom;
7. liquidation cascade with continued decline;
8. capitulation and absorption;
9. bullish change point after seller exhaustion;
10. sideways high-volatility range;
11. missing on-chain;
12. missing options;
13. stale OI;
14. conflicting exchange flow;
15. spoofed book without trade confirmation;
16. duplicate/out-of-order delivery;
17. price-scale invariance;
18. prefix/no-lookahead;
19. repeated render/alert evaluation;
20. quality downgrade during an episode.

Additional gates cover standalone low-valuation and positive-funding rejection, provisional-bar rejection, chart-adapter provisional/unavailable semantics, one event per episode, causal/directional CUSUM, bounded/monotonic hazard, locked settings migration, effective source toggles and leverage weights, worker bounds, absence of broker mutation/credentials, and 2,000-bar performance.

## Acceptance results

- High valuation alone: no confirmed top.
- Low valuation alone: no confirmed bottom.
- Liquidation cascade alone: no confirmed bottom.
- Positive funding alone: structurally unable to confirm a top without extremity/exhaustion/change point.
- Provisional change point: no confirmed event.
- Missing required data: `DATA_DEGRADED`, no confirmation.
- Exchange disagreement: confidence decreases.
- Duplicate calculation: identical IDs, no second event.
- Marker/alert source: same deterministic event object.
- Prefix equality: every tested prefix equals the corresponding full-run prefix.
- Strong continuation fixture: zero confirmed top reversals.
- Genuine deterministic top and bottom fixtures: each reaches its respective confirmed reversal.
- Broker mutation path: absent from the BC-TERA module.

## Empirical results not available

No certified historical BC-TERA feature dataset was available. Therefore the following were not run and must not be reported as passed: walk-forward backtest, purged/embargoed cross-validation, leave-one-cycle-out validation, untouched holdout, Brier score, calibration reliability, Deflated Sharpe, Probability of Backtest Overfitting, live-vs-backtest degradation, net performance after costs, historical false-positive rate, or reversal lead time.

Backtest partitions: **none**.  
Historical parameter trials: **0**.  
Calibration result: **not available / not certified**.  
Historical false-positive result: **not available**.  
Deterministic continuation/standalone-evidence fixtures: **0 false confirmed reversals in the specified negative fixtures**.

## Phase-II validation requirements

Freeze a versioned dataset and label manifest, then run purged walk-forward partitions with embargo, leave-one-cycle-out evaluation, an untouched final holdout, complete trial logging, source-revision simulations, venue-delisting/missing-data tests, realistic fees/funding/spread/slippage/latency, and calibration analysis. Report total trials whether successful or not.
