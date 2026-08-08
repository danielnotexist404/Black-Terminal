# BCLIF Swing Independence

The inventory model runs on a canonical OI/event clock, not the chart candle clock. Price movement can update distance, traversal state, and cascade context; it cannot create exposure.

Permanent executable assertions in `scripts/bclif-authentic-exposure-tests.ts` cover:

- large repeated swings with flat OI create zero cohorts and zero mass;
- a positive delta without an explicit OI interval creates zero cohorts;
- reversing aggressive buy/sell flow leaves paired birth IDs and mass unchanged;
- ±30% future price movement leaves entry and liquidation means fixed;
- projection viewport changes do not alter model/exposure hashes;
- timeframe presentation does not enter the model input;
- one batch and differently chunked canonical histories produce identical output;
- appending future frames preserves the finalized prefix.

The Playwright `SWING_INDEPENDENCE` fixture adds ten large price swings, trades, constant OI, and no liquidation events. Acceptance is exactly zero cohort births and zero operational shelves at all three required resolutions.
