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

When more visible price rows exist than the screen can physically fit, label projection divides the
complete visible scale into readable screen rows and chooses the cluster nearest each row center.
Hot/volume strength is only a deterministic tie-breaker inside the same row, so a dense lower-price
concentration cannot consume the label display. Collisions are suppressed without changing a
selected label's exact price Y. Weak label text uses Pine's static weak color rather than the darker
fill interpolation.

## Calculation/display separation

The worker snapshot contains no screen or viewport fields. `canonicalClusterHash` hashes only sorted
active/violated calculation output. Camera changes rebuild projection only. Pure price-domain tests
exercise five time windows while asserting an identical cluster hash.

## Optional display surfaces

The nearest-cluster summary table and cluster-ratio table each have an independent settings toggle.
The buy/sell oscillator output remains present in the canonical worker snapshot but is hidden by
default at render time. It can be enabled from the Style tab, where its buy and sell colors are also
configurable. These controls change presentation only; they do not change clustering calculations.

## Calculation lookback and loading telemetry

The indicator owns a persisted calculation lookback independent of the ordinary chart-history
selector: 5,000, 11,000 (default), or 22,000 chart bars. The retained chart source is sized for the
maximum selection and the history coordinator reports the selected target truthfully when the venue
cannot supply the full window. On a complete 1H/1m configuration, 22,000 chart bars require
1,320,000 ordered intrabars.

The loading overlay maps real chart-history pages, intrabar pages, grouping, validation, worker
calculation, and render stages into a continuous energy-bar progress display. Progress does not use
an artificial timer. Large-history warmup materializes sorted intrabar collections only at actual
warmup milestones instead of copying the growing collection after every page batch.

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
