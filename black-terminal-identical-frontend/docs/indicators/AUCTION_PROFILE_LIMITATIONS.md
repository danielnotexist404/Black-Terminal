# Auction Profile Limitations

- Public WebSocket/recent-trade feeds do not provide unlimited exact historical trades. Older chart history is approximate unless an archive is supplied.
- Pine Compatibility reproduces source behavior but requires same-window TradingView golden data for pixel certification.
- Some venues expose a side whose aggressor semantics have not yet been certified; those trades are INFERRED.
- Visible Range and visible-pixel adaptive sizing are intentionally camera-dependent.
- Price allocation from OHLCV bars is a model, not volume-at-price truth.
- Liquidation, DOM wall, IMM, Kioseff, HDLX, OMS/EMS, and Black Cloud calculations are not inputs to this engine.
- The profile is analytical information, not financial advice or a guarantee of future liquidity.
