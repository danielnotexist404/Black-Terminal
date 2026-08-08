# BCLIF Multi-Horizon Tiles

All horizons derive from one chronological high-resolution state. Supported manifests are 6H, 12H, 1D, 3D, 1W, 3W, 1M, and bounded custom ranges. Horizons are deterministic rollups, not independent models.

Tiles use fixed half-open time intervals and a stable price-grid contract. Every tile carries long, short, combined, confidence, validity, confirmed-liquidation, and optional peak/cascade channels plus causal normalization metadata. Gaps produce invalid columns; they are never zeros or interpolated exposure.

Finalized tiles are immutable. Codec `tileVersion=1` remains a compatibility generation, not a hot revision counter. A correction creates a new immutable checksum-addressed object and metadata identity, then records append-only supersession; a cumulative `STAGING` live edge advances through a later source cutoff, column count, checksum, and object path under the active writer fence before finalization. The client selects non-superseded finalized identities, binds every fetch to its manifest checksum, deduplicates overlaps, verifies header/manifest agreement, and replaces only the live edge. Compaction preserves exposure totals within quantization tolerance, sums quantitative confirmed-event notional/count before deriving display intensity, conservatively aggregates confidence, and retains peaks so narrow extremes are not averaged away.

Complete 3W coverage is not a tile-size claim. It requires three weeks of verified source continuity or equivalent observed input history.
