# DOM Pro Shared Price Camera

## Contract

`DomProPriceCamera` is the authoritative vertical price geometry for the Aggregated DOM Ladder, Volume Profile and Liquidity Heatmap. It synchronizes visible minimum/maximum price, center, zoom, pan offset, mode and current-price projection.

The camera does not own analytical data resolution. Every panel maps its native data into the same price range:

- Aggregated DOM Ladder: bounded wide buckets built from the current live venue book.
- Volume Profile: an independent high-resolution traded-volume grid (128 rows by default).
- Liquidity Heatmap: the native IMM history grid at canvas/pixel resolution.

This is the mandatory architecture: same price camera, different data engines and different row counts.

## Alignment Rules

- Wheel, drag, preset, Center and Fit update one camera.
- All panels project price through the same visible min/max range.
- Hover synchronization carries price, then each panel resolves that price against its own rows.
- Ladder bucket size must never downsample the profile or heatmap.
- Profile settings must never change ladder or heatmap aggregation.
- Pan and zoom do not create subscriptions, reload history or reset data stores.

## Verification

`npm run test:dom-pro-panels` rejects shared data grids and verifies native heatmap/profile resolution. `npm run test:dom-pro-visual` verifies camera range/current-price parity while independently requiring at least 128 profile rows and a heatmap grid denser than the ladder.
