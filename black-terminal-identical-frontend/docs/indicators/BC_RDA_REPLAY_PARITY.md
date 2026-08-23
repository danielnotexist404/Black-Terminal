# BC-RDA Replay and Runtime Parity

The certification harness exercises four equivalent source paths:

1. direct batch calculation;
2. worker history load followed by rebuild;
3. one-bar-at-a-time worker append followed by rebuild;
4. destroy/recreate/reload calculation.

It compares engine/model version, hashes, complete series, causal events, raw/final signals, signal-intelligence state, integrity state, and latest metrics. `calculatedAt` and measured runtime are excluded because they are observational metadata.

`CausalRdaSignalMachine.checkpoint()` persists version, settings hash, timeframe, rolling data-hash state, Long candidate/trough/recovery state, Short upper-extreme/rollover state, and emission state. Restore rejects model or configuration mismatches. Split-run output and final checkpoint must exactly equal uninterrupted processing.

Certified source results on 2026-08-23:

- worker batch/stream parity: 40/40;
- reload parity: 40/40;
- checkpoint parity: 40/40;
- open/developing bar final emissions: 0;
- backpainted execution timestamps: 0.

This is repository source/worker certification. It does not certify a separately deployed VPS automation adapter; that adapter does not exist and execution remains blocked.
