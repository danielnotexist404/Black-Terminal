# Auction Profile Pine Compatibility

The original source is retained unchanged at `reference/pine/cvd-profile-v6.pine`. Compatibility mode is separate from Black Core Native and never consumes real-trade formulas silently.

The implementation preserves the source direction rule, uniform lower-timeframe range allocation, signed CVD, total-volume POC, symmetrical value-area expansion, regular/fixed scope distinction, and CVD delta/acceleration intent.

Known source anomalies retained for compatibility:

- direction is lower-timeframe close-to-close, not aggressor side;
- buy/sell row fields are overwritten before the ratio, not accumulated;
- imbalance divides buy by sell and retains zero-denominator behavior;
- activity is reset during chart-bar updates;
- automatic row size multiplies ATR by minimum tick;
- value area expands symmetrically around POC;
- `max_bars_back=1500` conflicts with `calc_bars_count=10000`.

Compatibility and native output must never be compared as if they represented the same data model. Pixel-level TradingView certification still requires a golden export from the same venue, history window, and Pine settings.
