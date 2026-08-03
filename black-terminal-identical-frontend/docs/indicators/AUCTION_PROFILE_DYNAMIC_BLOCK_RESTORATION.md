# Auction Profile Dynamic Block Restoration

## Diagnosis

The first conversion kept the aggregate row model as the renderer's only input. Each price row therefore had one cumulative value, so Pixi could only draw a right-aligned histogram and project detected nodes as long horizontal zones. Enabling the histogram, nodes, labels, acceptance zones, and extensions together turned a time-by-price indicator into a macro level map.

The responsible path was:

- `nativeEngine.ts`: reduced trades and bars to `AuctionProfileRow[]`;
- `AuctionProfileRenderer.ts`: consumed only those cumulative rows;
- legacy rendering defaults: enabled the aggregate and structural interpretation together.

Opacity changes could not repair the missing time dimension.

## Restored product

BC-MEAP 2.0 adds a sparse `AuctionBlockMatrix` to every snapshot. Its primary presentation is now:

```text
time blocks × price rows × selected engine value
```

The default is **Dynamic Blocks + Key Levels**. Aggregate Histogram and Macro Structure remain explicit optional presentations.

Each visible non-empty cell:

- spans its exact block start/end and row low/high;
- uses the selected engine value;
- renders gray-to-white when positive and dark-red-to-blood-red when negative;
- uses a near-black border;
- shows a compact signed value when geometry and label budgets permit;
- exposes full inspection data on hover.

## Lifecycle

The latest block is developing. Exact live trades mutate only their indexed cell. Completed blocks and completed historical sessions are finalized. When multiple sessions are calculated, all snapshots remain in chart state and use the same renderer; only the latest snapshot drives the compact legend.

## Default noise policy

- dynamic matrix on;
- POC, VAH, VAL, and IB on;
- aggregate histogram off;
- LVNs and HVNs off;
- structural S/R and historical extensions off;
- node labels off;
- midpoint off.

## Validation

`scripts/auction-profile-tests.ts` certifies exact row/block allocation, `+3 / -4 / +6` CVD cells, finalized-cell stability, session retention, conservation, text formatting, color endpoints, camera-independent bounds, worker incrementality, and semantic signed downsampling.
