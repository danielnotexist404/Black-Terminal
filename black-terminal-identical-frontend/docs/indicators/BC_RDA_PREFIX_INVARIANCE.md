# BC-RDA Prefix Invariance

## Invariant

For an immutable closed prefix `P = bars[0..n)`, recalculating after any future suffix is appended must preserve, for all timestamps in `P`:

- every numerical and categorical series value;
- causal event identity, timestamp, type, state, and point-in-time metadata;
- every final signal and all lifecycle/timestamp fields;
- settings/data hashes attached to final signals.

The current active episode summary may grow because it is a present-time diagnostic. It is not a final signal ledger and is deliberately excluded from the immutable comparison.

## Executable proof

Run `npm run test:dda-pro-no-repaint`. `scripts/dda-pro-no-repaint-certification.ts` compares full calculations with:

- 180 fixed prefixes across BTCUSDT, ETHUSDT, SOLUSDT, and XRPUSDT and both Native and Pine Compatibility calculation modes;
- 5m, 15m, 1h, 4h, and 1d clocks;
- 100 deterministic random truncations;
- future appends of 10, 100, and 1,000 bars in addition to the base prefix.

Tolerance for numerical series is `1e-10 * max(1, |a|, |b|)`. Events and signals require exact structural equality. Certified result on 2026-08-23: zero finalized signal, value, and timestamp drift.

The same harness intentionally proves that `BC_RDA_LEGACY_REPAINTING` violates the signal invariant.
