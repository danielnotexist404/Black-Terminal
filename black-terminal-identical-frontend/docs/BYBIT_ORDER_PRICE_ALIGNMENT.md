# Bybit Order Price Alignment

The order line uses the normalized numeric value of Bybit's `price` field. The original venue string is retained as `venuePriceString` for inspection. Trigger price is never substituted for a working limit price.

Black Terminal projects the price through `BlackChartEngine.getScreenYForPrice`, which delegates to the chart's authoritative linear/log transform. Pixel coordinates are produced at render time and are not persisted.

The Pixi host begins 44 CSS pixels below the chart component header. The venue-order overlay now shares that exact host origin (`inset: 44px 0 0`); previously it used the component origin, creating a fixed visual displacement despite correct price mathematics.

