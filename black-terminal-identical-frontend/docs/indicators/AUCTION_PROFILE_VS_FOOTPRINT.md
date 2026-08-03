# Auction Profile vs CVD Footprint

| Contract | Auction Profile | CVD Footprint |
|---|---|---|
| Dimensions | selected range × price | time block × price |
| Primary question | Where did the range accept or reject directional flow? | What happened at each time/price intersection? |
| Input projection | aggregate rows plus chronological row-cell chains | sparse matrix cells |
| Width | selected row metric expressed as packed profile blocks | exact cell time span |
| Default role | Auction Profile indicator | CVD Footprint candle type / optional indicator view |
| Labels | developing row CVD or signed block delta | cell values |
| Renderer | `AuctionProfileRenderer` | `CvdFootprintRenderer` |

The prior chart-type implementation called Volume Footprint was a sinusoidal OHLCV painter. It did not consume canonical order flow. It has been removed. Selecting **CVD Footprint** now starts the Auction worker even when the Auction Profile indicator is not enabled, draws subdued OHLC reference candles, and overlays the preserved canonical time × price matrix.

The indicator selector offers Auction Profile, CVD Footprint, and Combined. Combined is intentionally dense and is not the default.

The crucial boundary is coordinate space: Auction Profile packs chronological cells from one profile anchor so the cells themselves form the range's price silhouette. CVD Footprint projects those cells onto their original chart timestamps beside the candles.

Truth remains explicit: exact CVD requires classified aggressor trades. OHLCV fallback is labeled approximate and is never promoted to exact flow.
