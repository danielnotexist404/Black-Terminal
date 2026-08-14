# BC-RDA limitations

- Exact TradingView parity is unverified without exported golden fixtures, US10Y history, and theme screenshots.
- The Python engine is an auditable reference, not a deployed production sidecar.
- Cross-language tests currently certify the numerical distribution core, not every dashboard metric/hash.
- Connected-account and strategy equity are intentionally hidden until canonical authorized series providers exist. Price is not substituted.
- The versioned worker protocol supports initialize, history load, append, configuration update, rebuild, and cancellation. The React chart path currently uses direct worker calculations with confirmed-input identity suppression; Developing Preview still performs a bounded rebuild, so a true incremental numerical kernel remains future work.
- Developing Preview can change the current candle. Confirmed Bars Only excludes a still-open candle when its timestamp/timeframe proves it is open.
- Read-only DDA events can be registered through the existing alert center. Alerts are confirmation-gated and have no execution authority.
- No claim is made that this indicator predicts returns, prevents losses, or constitutes investment advice.
