# Kioseff Pine State Model

## Execution order

Pine Compatibility is a single chronological state machine. It is never parallelized across bars.
For each parent bar the worker restores the last committed state, processes ordered child bars,
commits a closed bar, and treats only the final open bar as provisional and replayable.

## Absorbtion state

Sell and buy call sites own independent active, violated and pivot-fill arrays. IQZZ owns persistent
points, direction and confirmed pivot history. Violations precede new cluster creation. Curves and
last-bar selection are derived output and may not mutate calculation state.

## VAE higher state

- Active and removed records use integer `floor(price / mintick)` keys.
- Separate sorted key arrays preserve Pine binary-search and removal order.
- Existing records update signed volume and last-add time.
- Intrabar projections are inserted before wick crossings are removed.
- New same-parent records are removed but are not retained as historical records.
- Maps prune from 25,000 to 20,000 keys using Pine's distance direction.
- Display is rebuilt into 496 active and 451 removed candidate bins with end-exclusive Pine slices.

## VAE lower state

- `SMA(ATR(14), 50) / 4` freezes once and is never relocated.
- Levels, active records and removed records remain index-aligned arrays.
- Boundaries extend before projection lookup.
- Violations copy active volume/time into the removed slot, then zero the active volume and stamp its
  new start time.
- Level arrays prune at 2,500 from Pine's selected side.
- Last-bar output selects at most 495 active cells around current close and 450 historical cells by
  descending absolute removed volume.

## Display-state semantics

Lower p95 receives signed cell values. Its five-slot top-cluster array starts at zero and admits only
values greater than its current minimum. The later hot comparison uses magnitude. Higher display
bins already contain absolute sums. Hot graphics are limited to five line pairs in display order.

Historical lower and higher geometry perform different backward overlap searches. Their output
endpoints follow the retained Pine code; `violationTime` is preserved separately for diagnostics.

## Provisional behavior

Only the final batch bar may be provisional. A replacement provisional revision always starts from
the last closed committed state. This prevents double-counting intrabars and reproduces Pine rollback
semantics without mutating the closed snapshot.
