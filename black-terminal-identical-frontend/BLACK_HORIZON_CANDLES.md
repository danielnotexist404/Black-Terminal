# Black Horizon Candles

Black Horizon Candles is an opt-in Black Terminal chart display mode. It keeps the market-data source at one second while allowing the user to view that stream as a 15-minute, 1-hour, 4-hour, or 1-day horizon. Changing the horizon changes the viewport and render density; it never replaces the one-second source with conventional higher-timeframe OHLC candles.

## Integrity contract

- `sourceResolution` is locked to `1s`.
- Native aggressor trades are classified and aggregated into append-only one-second candles. Their exact buy volume, sell volume, and signed delta survive higher render aggregation.
- The renderer never fabricates historical one-second candles. If complete venue history is unavailable, the mode starts with the exact recent trade window, collects forward, and reports `DEGRADED` until coverage grows.
- `NATIVE TRADES` means one-second bars were built from classified trades. `NATIVE 1S` means the venue supplied an authoritative one-second bar. `SYNTHETIC 1S` is visible only for explicit mock/demo operation. These states are never interchangeable.
- Crosshair inspection always resolves back to the exact source candle even when the visible scene uses clusters or a wave.

## Direction model

Each render bucket calculates a normalized direction score:

```text
score = 0.35 * centerlineSlope
      + 0.25 * cvdSlope
      + 0.20 * acceptanceMigration
      + 0.20 * rejectionImbalance
```

All components are bounded to `[-1, 1]`.

- `centerlineSlope`: volume-weighted centerline migration divided by bucket range.
- `cvdSlope`: signed aggressor delta divided by total volume.
- `acceptanceMigration`: movement from opening price through the volume-weighted centerline to the closing price.
- `rejectionImbalance`: lower-wick rejection minus upper-wick rejection.

If authentic delta is unavailable, the CVD term is removed and the remaining weights are renormalized. This avoids inventing order flow from candle direction.

The envelope is centered on the volume-weighted typical price. Its dispersion expands with bucket range, compression/expansion velocity, and asymmetric wick rejection. Silver/white expresses positive directional pressure; blood red expresses negative pressure. The colors do not claim guaranteed future direction.

## Level of detail

LOD is selected from source candles per physical pixel:

- `<= 1`: individual one-second micro candles.
- `> 1 and <= 8`: deterministic OHLCV/delta clusters.
- `> 8`: continuous wave envelope and pressure field.

The source buffer is not replaced during LOD transitions. Only submitted Pixi geometry changes. Rendering uses batched `Graphics` layers and typed projection arrays; it does not create one Pixi display object per source candle. The horizon source buffer is capped at 100,000 samples and the viewport projection cache at six entries.

## Components

- `src/modules/horizon-candles/core/HorizonWaveEngine.ts`: deterministic projection, direction, envelope, LOD, cache, and exact-source lookup.
- `src/modules/horizon-candles/rendering/HorizonCandleRenderer.ts`: envelope, pressure, rejection, micro-candle, and crosshair layers.
- `src/chart-engine/BlackChartEngine.ts`: isolated chart-engine integration and retention limits.
- `src/components/PixiBlackChart.tsx`: one-second acquisition, data-quality state, horizon controls, and preferences.
- `src/modules/horizon-candles/core/settings.ts`: persisted settings, migration, and feature flag.

## Feature flag and rollback

Set `VITE_BLACK_HORIZON_CANDLES_ENABLED=false` at build time to remove the menu item and force any stored Horizon selection back to standard candles. No database migration is required. Rollback is therefore either the feature flag or the previous immutable frontend image.

## Certification

Run:

```bash
npm run test:horizon-candles
npm run typecheck
npm run build
```

The Horizon test constructs 14,400 deterministic one-second samples, certifies all three LOD states, exact crosshair recovery, weight renormalization without delta, cache bounds, the 100k retention contract, menu flagging, and projection performance.

For visual certification only, localhost accepts `?horizonVisualFixture=1`. The fixture supplies deterministic one-second candles and is visibly labelled `SYNTHETIC 1S`; the switch is ignored on non-local hosts.
