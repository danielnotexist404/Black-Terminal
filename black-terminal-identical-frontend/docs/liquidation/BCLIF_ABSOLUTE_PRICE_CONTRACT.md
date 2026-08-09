# BCLIF absolute-price contract

The authoritative model contract is `AbsoluteLiquidationDistribution`.

| Field | Invariant |
| --- | --- |
| `priceUnit` | Exactly `QUOTE_PRICE` |
| `gridOrigin` | Finite, versioned lattice origin |
| `minPrice` / `maxPrice` | Absolute exchange quote prices |
| `priceStep` | Positive finite quote-price increment |
| `rows` | Integer >= 2 |
| Grid closure | `maxPrice = minPrice + priceStep × (rows - 1)` |
| Cohort anchor | Entry and liquidation distributions never depend on screen pixels |
| Display | May resample the grid, never redefine it |

The browser owns one grid for the lifetime of a fallback controller generation
and passes it through the actual worker protocol. A 60-second bootstrap refresh
cannot choose a new first-frame lattice. A model-grid row-count change starts a
new grid generation. Persistent tiles remain protected by their model, schema,
tile, source, checksum, and price-grid metadata.

The full path is:

`absolute entry distribution → venue liquidation math → absolute particle
liquidation price → absolute grid row → raw mass → presentation intensity`.

Current mark may affect causal lifecycle evidence and the selected display
domain. It is never an alternate coordinate system for stored cohorts.
