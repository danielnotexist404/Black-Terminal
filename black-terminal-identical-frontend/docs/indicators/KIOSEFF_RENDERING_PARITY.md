# Kioseff Rendering Parity

## Active VAE geometry

Each non-zero display cell remains a price range. Active ranges extend right from the Pine-derived
start timestamp. Weak cells interpolate RGB from the chart background to the configured weak color
while alpha interpolates from 2% to 10%. Strong cells retain the configured strong color and
interpolate alpha from 5% to 10%. Hot cells add Pine's opaque core and 5-pixel 10%-alpha glow.

## Historical geometry

VAE historical objects are duration-preserving lines, not replacement filled boxes. Lower history
uses the midpoint between weak and strong colors at 50% alpha. Higher history uses its removed-bin
continuous gradient. Absorbtion historical zones retain their range geometry.

## Labels

`Show Active Cluster Size` keeps the Pine default `false`. When enabled, every eligible active VAE
cell can acquire a pooled text object up to the Pine capacity of 496. Labels preserve sign, use
compact K/M/B/T formatting and align at the right plot edge. Historical VAE labels remain disabled,
matching Pine.

When more visible price rows exist than the screen can physically fit, label projection evaluates
the full visible grid, retains hot/stronger rows first, and suppresses collisions without changing a
selected label's exact price Y. It does not consume the pool from the lowest grid index or shift text
downward. Weak label text uses Pine's static weak color rather than the darker fill interpolation.

## Calculation/display separation

The worker snapshot contains no screen or viewport fields. `canonicalClusterHash` hashes only sorted
active/violated calculation output. Camera changes rebuild projection only. Pure price-domain tests
exercise five time windows while asserting an identical cluster hash.

## Price-domain policies

- `Candles Only`
- `Candles + Active Clusters`
- `Candles + Visible Cluster Geometry` (compatibility default)
- `Fixed Manual Scale`

The default includes time-intersecting, nearby geometry and refuses extreme distant levels that would
collapse the candle display. Inclusion changes only the axis domain; every cluster retains its exact
price and calculation identity.

## Remaining visual gate

Pixel parity for TradingView font metrics, mobile scaling and the exact runtime
`chart.bg_color` requires synchronized screenshot certification after numeric golden equality.
