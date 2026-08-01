# Kioseff TradingView Golden Masters

This directory is the approval boundary for Pine Compatibility Mode. Expected snapshots must be
exported from the retained Kioseff Pine script running on TradingView with the exact same immutable
Bybit data, terminal timestamp, tick size, and all 18 Pine inputs used by Black Terminal.

`manifest.json` deliberately contains only pending rows. Do not populate a reference from Black
Terminal output and do not change a row to `approved` without:

1. the canonical source-data fixture and complete lower-timeframe coverage report;
2. TradingView active, violated, and current-bar revision snapshots;
3. matching source, data, and settings hashes;
4. a zero-material-difference numerical run; and
5. a synchronized screenshot comparison using the same time and price domain.

See `docs/indicators/KIOSEFF_GOLDEN_MASTER_PROTOCOL.md` for the complete procedure.
