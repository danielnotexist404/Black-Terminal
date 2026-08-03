# RADAP — Range Anchored Directional Auction Profile

RADAP is the production identity of Black Terminal's range-anchored directional CVD profile. The public name replaces Auction Profile; existing internal TypeScript types, worker messages, storage keys, and workspace fields retain their historical names to guarantee backward compatibility.

## Stable settings lifecycle

Presentation controls redraw the current certified snapshot immediately and do not restart calculation. Calculation-sensitive controls are debounced before a new worker generation begins. During that rebuild the last certified snapshot remains visible, and an empty or cancelled intermediate result cannot erase it. Completed asynchronous work is always rendered with the newest presentation settings rather than the settings captured when the worker started.

## Deferred live-number phase

The matrix currently exposes finalized historical CVD blocks plus the developing block supported by available classified trades. Continuous per-cell number mutation across the developing matrix is intentionally deferred to the next phase so its cadence, provenance, and performance limits can be specified and certified independently of this stability correction.
