# DOM Pro Shared Price Camera

## Contract

`DomProPriceCamera` is the authoritative vertical price domain for the Aggregated DOM Ladder, Volume Profile and Liquidity Heatmap in Shared mode. It owns the visible range, center, zoom, pan offset, row count, bucket size, stable bucket keys and normalized row geometry.

All three panels receive the same camera object. They do not derive independent Y scales or round their own bucket boundaries. Wheel, drag, preset, Center and Fit actions update the existing heatmap viewport once; every consumer redraws from the resulting camera.

## Alignment Rules

- A price belongs to one exact `DomPriceBucket` through `domPriceBucketAt`.
- Ladder rows, profile nodes and heatmap cells use that bucket's low, high, center, top percentage and height percentage.
- Current price is projected through `domPriceToTopPct` in all three panels.
- Hover state carries the shared bucket key so the corresponding row highlights across panels.
- Pan and zoom never create a market-data subscription, reload history or reset the user's camera.

Independent and Follow ladder modes remain explicit panel settings. Shared is the factory default and the institutional alignment mode.

## Verification

`npm run test:dom-pro-panels` verifies bucket parity, pan, zoom, Fit/Follow construction and reconnect preservation. `npm run test:dom-pro-visual` asserts exact camera version, range, bucket size and current-price Y parity at Follow, +/-5%, manual pan, manual zoom, +/-20% and Fit states.

