# DOM Pro Aggregated Ladder Synchronization

## Root Cause

The first ladder repair derived a separate near-market range from the current venue book. That made non-zero quantities visible, but separated the ladder from the Heatmap and Volume Profile camera. Wide Macro and Full Data views could therefore display unrelated price rows beside each other.

## Corrected Pipeline

```text
MarketDataEngine (one order-book owner)
  -> DomFeedStore (one normalized market snapshot)
  -> DomProPriceCamera (one visible price domain)
  -> exact shared buckets
       -> Aggregated DOM Ladder: current live bid/ask sums
       -> Volume Profile: visible historical/profile sums
       -> Liquidity Heatmap: historical depth intensity
```

The ladder aggregates raw venue levels directly into shared buckets. Bid and ask bars use separate robust 90th-percentile references, preserving relative queue-size structure without letting one outlier flatten the panel. Best bid, best ask, current price and IMM wall confluence remain separate markers.

## Subscription Ownership

The ladder model is a pure function. It cannot open a socket or fetch a venue. `useDomFeed` remains the only DOM Pro feed hook and `MarketDataEngine` retains subscription deduplication. Camera movement recalculates only bounded presentation buckets.

## Evidence

- Deterministic model and source-ownership checks: `npm run test:dom-pro-panels`
- Browser camera and rendering contract: `npm run test:dom-pro-visual`
- Public Bybit raw-book comparison: `npm run certify:dom-pro-camera`
- Evidence file: `docs/validation/dom-pro-shared-camera-live-certification.json`

