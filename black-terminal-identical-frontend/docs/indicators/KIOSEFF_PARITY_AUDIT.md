# Kioseff Pine Compatibility Parity Map

**Canonical source:** `reference/pine/kioseff-stop-loss-clustering-v6.pine`  
**Source SHA-256:** `ee848e8e1de892c088648980a0d8e422d93800d131d235ff2dc3b79d4c7ebf11`  
**Audit status:** complete static map; TradingView golden certification pending  
**Engine mode:** `pine-compatibility` only; `black-core-enhanced` is certification-gated

This is the active correction map. The earlier 1,328-line
`KIOSEFF_STOP_LOSS_CLUSTER_PARITY_AUDIT.md` retains the pre-implementation repository audit and
full semantic narrative. Neither document is evidence of output parity. Approval requires the
machine-readable TradingView fixtures described in `KIOSEFF_GOLDEN_MASTER_PROTOCOL.md`.

## Input map

The Pine source has 18 inputs at lines 14–33. The dedicated Black Terminal Inputs tab maps all 18;
Style and Visibility are separate platform groups and are included in the settings hash.

| Pine lines | Pine input | TypeScript field | Status |
|---|---|---|---|
| 14 | `model` | `model` | mapped |
| 16–24 | Absorbtion x-ray, intensity, four limits, LTF and two colors | `absorbtion.*` | mapped; invalid non-lower LTF fails through the data contract |
| 26 | `granularity` | `volatilityAtEntry.granularity` | mapped |
| 27 | `timeScaledVolaIn` | `volatilityAtEntry.timeScaledVolatilityTimeframe` | mapped as factor baseline; VAE source data remains hard-coded 1m like Pine |
| 28–31 | strong/weak colors, historical triggers, active size | `volatilityAtEntry.*` | mapped |
| 32–33 | force typical move, ratio meter | top-level fields | mapped |

## Type and persistent-state inventory

| Pine lines | Pine state | TypeScript equivalent | Correction/test |
|---|---|---|---|
| 35–43 | `swingData` | `SwingRecord` | active/violated Absorbtion lifecycle; engine tests |
| 44–48 | `volTime` | `VolTime` | mutable signed volume/time record |
| 49–55 | `stopClusterDraw` | canonical cluster plus render zone | drawing objects are batched, semantics retained |
| 56–61 | `barData` | `BarStat` | chronological high/low/time overlap search |
| 62–69 | `timeScaledVola` | `HigherState` plus `barStats` | map plus sorted ordered key arrays |
| 70–83 | VAE drawing/last-bar records | `DisplayCell`, canonical/render models | rebuilt from engine state without mutating it |
| 84–100 | `offChartData` | snapshot outputs, summary, pane and ratio | mapped |
| 101–106 | `lowerGranularity` | `LowerState` | parallel levels/active/removed arrays |
| 107–112 | `similarities` | sorted similarity helpers | mapped for Absorbtion |
| 113 | `timeArrBin`, `barMs` | state `bars`/`barStats`, timeframe seconds | ordered timestamps; no viewport input |
| 129–134 | IQZZ `points`, pivot arrays and `dir` | Absorbtion persistent pivot fields | committed/provisional rollback tests |
| 247 | retained qCurve polylines | canonical curves, last 50 | mapped |
| 460 | 50 x-ray boxes | bounded x-ray graphics strips | mapped |
| 526–528 | independent call-site cluster/old/fill arrays | independent `sell` and `buy` `SideState` | mapped; independence test |
| 623–646 | last-bar drawing arrays and pulse label | render model/text pool | batched; no calculation state |
| 687 | factor baseline `t0` | constructor factor baseline | mapped |
| 874–909 | factors, lower grid, removed totals, maps, frozen width, total=18 | VAE engine factors and state | mapped; frozen-grid and signed tests |
| 1146–1155 | active/removed drawing arrays and 496 labels | Pixi batches and 496 pooled texts | corrected from 120 |
| 1516 | global `offChart` | canonical output state | mapped |
| 1573–1590 | model/color constants and active pane flag | snapshot model/pane render | mapped |
| 1654–1712 | summary and ratio tables | React overlays | mapped; visual certification pending |

## Function/block parity map

| Pine lines | Function/block | TypeScript equivalent | Current status | Required golden fixture |
|---|---|---|---|---|
| 115–125 | `updatePivot` | `updateIqzz` internal update | structurally mapped | alternating continuation/reversal |
| 126–183 | `IQZZ` | `AbsorbtionExtremesEngine.updateIqzz` | parity pending golden history/realtime revisions | Absorbtion 1H |
| 184–238 | `qCurve` | `curves` + Pixi polyline | shape mapped; dash appearance pending screenshot | Absorbtion active/violated |
| 239–452 | `gradBox` | Absorbtion canonical/render pipeline | batched equivalent; strip-level screenshot pending | Absorbtion x-ray/intensity matrix |
| 453–481 | `xRay` | render-model x-ray | mapped | x-ray on/off |
| 482–523 | `checkVioandAddRec` | `violate` | mapped | immediate/1/100-bar violations |
| 524–596 | `getClusterPoints` | Absorbtion engine process path | mapped to ordered LTF input | Bybit 1H LTF fixture |
| 597–618 | drawing removal | pooled render reset | mapped without calculation mutation | mount/unmount soak |
| 619–671 | last-bar Absorbtion selection | `newestBySide`, summary | mapped | all four limits |
| 672–684 | higher historical `findStart` | `findHistoricalStart(..., "higher")` | corrected | higher historical-on |
| 685–691 | `sq` | 18 factor construction | mapped | non-default factor baseline |
| 692–722 | pruning direction | `deleteDirection` | mapped | >1,000 and both distance directions |
| 723–744 | higher/lower pruning | `pruneHigher`, `pruneLower` | mapped | 25k/20k and 2,500 boundaries |
| 745–776 | `findStartNow` | `findAddedStarts` | mapped | grid extension both sides |
| 777–798 | lower removed `findStartEnd` | `findHistoricalStart(..., "lower")` | corrected from zero-width | five lifecycle fixtures |
| 799–819 | lower last-bar cell ordering | `lowerActiveCells`, `lowerCell` | mapped at 495 cells | lower 4H golden |
| 820–864 | `findTypical` | Absorbtion similarity helpers | structurally mapped | force on/off |
| 865–868 | `req` | 1m ATR, inverted signed volume, HLC3/L/H | mapped | exact Bybit 1m fixture |
| 869–1514 | `timeScaled` | `VolatilityAtEntryEngine` | confirmed signed percentile, bin slicing, hot budget, history and gradient corrections; golden pending | BTCUSDT 1H/4H lower+higher |
| 1516–1572 | model dispatch/off-chart mutation | parity engine and snapshot outputs | mapped | both models |
| 1573–1652 | percentile averages/pane plots/alerts | Pine series, pane and alert events | mapped structurally | current-bar revision fixture |
| 1653–1787 | summary/ratio/alerts | React overlay and alert output | mapped structurally | synchronized screenshot |

## Confirmed corrections in this restoration

- Lower VAE p95 and top-five ranking now preserve signed input values. Higher bins retain Pine's
  absolute aggregation.
- Higher display slicing uses Pine leftmost/rightmost end-exclusive semantics and includes empty bins
  in threshold statistics.
- Hot drawing eligibility is limited to Pine's five line pairs in ascending display order.
- Higher displayed bin values remain positive as Pine produces them; lower values retain sign.
- Lower and higher historical spans use the corresponding Pine backward overlap searches.
- Canonical clusters now preserve absolute volume, percentile, normalized strength, granularity,
  historical state, bar indices and engine version.
- Active gradients interpolate continuously from the chart background; historical lower triggers use
  Pine's midpoint weak/strong color at 50% opacity.
- VAE historical geometry renders as duration-preserving lines rather than filled replacement boxes.
- Label capacity is 496 and values retain sign with Pine-like compact volume formatting.
- Calculation and display domains are separate; cluster hashes exclude all camera state.

## Unresolved certification rows

No approved TradingView canonical snapshots exist in the repository. Consequently exact ATR seed,
TradingView lower-timeframe feed identity, current-bar revisions, every cluster boundary/value and
pixel-level color parity remain **unapproved**, even where structural tests pass. Black Core Enhanced
Mode must remain disabled until all golden rows pass.
