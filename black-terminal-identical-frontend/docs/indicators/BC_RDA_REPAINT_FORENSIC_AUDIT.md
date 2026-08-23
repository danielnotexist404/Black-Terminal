# BC-RDA Repaint Forensic Audit

Status: root cause reproduced and contained on 2026-08-23.

## Finding

The former historical dots were not immutable signal events. `buildEpisodes()` in `src/modules/dda-pro/core/engineShared.ts` retained one mutable active episode and rewrote `troughIndex` every time a later bar made a deeper drawdown. `deriveLegacyEvents()` then projected a single `DDA_DRAWDOWN_DEEPENED` event onto that latest trough, and `deriveDDAProSignals()` converted it to a Long dot. Appending future candles therefore moved an already displayed historical marker.

The minimal reproduction is executable in `scripts/dda-pro-no-repaint-certification.ts`: the same unfinished episode is calculated at successively longer prefixes, and its Long marker index changes. This is now an expected proof of failure for `BC_RDA_LEGACY_REPAINTING`, never a certification test for production use.

## Secondary time-instability

The old engines also derived effective lookback/warm-up from the currently loaded array length and attached one current-snapshot confidence value to older events. Increasing the loaded prefix could therefore change historical validity/confidence metadata. `calculateDDAProNative()` and `calculateDDAProCompatibility()` now use the configured fixed lookback and point-in-time event confidence.

## Complete path

1. Chart source: `PixiBlackChart.tsx` constructs `DDAProCalculationInput`.
2. Worker: `DDAProWorkerRuntime.rebuild()` invokes `calculateDDAPro()`.
3. Engine: native or compatibility calculation builds causal trailing series.
4. Legacy event projection: `buildEpisodes()` -> `deriveLegacyEvents()`.
5. Legacy marker conversion: `deriveDDAProSignals()`.
6. Rendering: `BlackChartEngine.renderDDAPro()` draws `snapshot.rawSignals`/`snapshot.signals`.
7. Former alert consumer: `ddaProAlertSignalStream()`; now hard-disabled.

## Function-by-function causality trace

| Stage | Source and function | Historical input available at bar `t` | Audit result |
|---|---|---|---|
| Canonical bars | `src/components/PixiBlackChart.tsx` (`DDAProCalculationInput`) | Ordered chart candles; forming candle is marked separately | `confirmed-bars` excludes the forming candle from final signal state. |
| Worker/replay | `src/modules/dda-pro/workers/runtime.ts` (`DDAProWorkerRuntime.handle`, `rebuild`) | History load or ascending `APPEND` messages | Both paths call the same `calculateDDAPro()` engine. `APPEND.confirmed` is preserved. |
| Running peak | `src/modules/dda-pro/core/nativeEngine.ts` (`calculateDDAProNative`) and `statistics.ts` (`rollingMaximum`) | All prior/current values, or `[t-L+1,t]` | Causal. No future peak is applied backward. Compatibility mode uses the same running-maximum behavior as the source Pine model. |
| Drawdown/depth | `calculateDDAProNative()` / `calculateDDAProCompatibility()` | `source_t` and `peak_t` | Causal point value. |
| Distribution bands | `statistics.ts` (`rollingDistribution`) | Sorted trailing window with the value at `t` inserted and `t-L` removed | Mean, deviation, rank, and p05..p99 at `t` never use later samples. |
| Smoothing | `statistics.ts` (`smoothSeries`) | Trailing SMA, recursive EMA/RMA, or no smoothing | All allowed modes are one-sided. |
| Legacy trough | `engineShared.ts` (`buildEpisodes`, `deriveLegacyEvents`) | Mutable episode summary recomputed over the entire supplied prefix | **Failure:** later deeper bars rewrite `troughIndex`, then project the marker backward. Preserved only as Legacy Research. |
| Causal candidates | `causalSignalEngine.ts` (`CausalRdaSignalMachine.append`) | One ascending closed-bar frame at a time | Long threshold entry/deepest developing anchor and Short upper-extreme anchor remain provisional. |
| Confirmation | `CausalRdaSignalMachine.append`, `finalSignal` | Past/current recovery or rollover streak only | Final event time/index is the confirmation bar. Anchor is provenance only. |
| Storage identity | `finalSignal`, `signalId`, `dataHash` | Confirmation context and the consumed prefix | Versioned stable ID plus settings/data hashes; checkpoint binds version, settings, timeframe, hash and candidate state. |
| Renderer | `src/chart-engine/BlackChartEngine.ts` (`renderDDAPro`) | Immutable snapshot series and signal events | Draws final marker at `signal.index`; does not detect, move, or create a signal. |

## Explicit prohibited-operation search

The mandated search covered `src/modules/dda-pro`, the BC-RDA Python reference, the original Pine reference, and the chart renderer.

- No `shift(-N)`, `lead()`, centered rolling, `filtfilt`, centered Savitzky-Golay, `find_peaks`, `argrelextrema`, reverse slicing, right-bar pivot, full-series normalization, global percentile, or final-distribution operation exists in the BC-RDA calculation/signal path.
- `python/black_core_indicators/dda_pro/*.py` contains `from __future__ import annotations`; this is a Python language import, not future market-data access. Its peak, smoothing, and distribution implementations are forward loops/trailing slices. It produces read-only analytics and no signal ledger.
- `reference/pine/dda-pro-edgetools-v6.pine` uses `request.security(..., lookahead=barmerge.lookahead_off)`, which explicitly disables forward lookup. Its other occurrence of “future” is a performance disclaimer.
- `reference/pine/cvd-profile-v6.pine` contains `lookahead_on` for a daily session boundary. That is a separate CVD-profile reference, is not imported by BC-RDA, and CVD confirmation is forcibly disabled in Causal V2.
- Pivot matches occur only in the unrelated stop-loss-clustering Pine reference and are absent from the BC-RDA runtime path.

## Cloud and presentation audit

`rollingDistribution()` produces a distinct immutable p05..p99 and sigma value for every historical bar from that bar's trailing window. `BlackChartEngine.renderDDAPro()` merely joins those stored points. Quantile/sigma fill opacity is a fixed function of the user `fillIntensity` and band ordinal; there is no retrospective local-maximum or future-aware “fade” classifier. A pane-wide current-risk tint uses only `snapshot.latest.riskState`; it is explicitly present-time decoration and is not part of any historical band hash, event, signal, alert, or execution condition.

The Causal V2 fading/reversal evidence used for signals is therefore state-machine evidence, not renderer inference: Long uses a trailing recovery slope/streak from the developing trough; Short first arms at full recovery and becomes final only after a later closed-bar rollover streak. No historical analytical anchor is execution-eligible.

## Classification

- Model name: `BC_RDA_LEGACY_REPAINTING`.
- Use: visual research comparison only.
- Historical performance statistics: invalidated.
- Alerts, backtests, Paper, Bybit Demo, investment-group, and live automation: blocked.
- Existing records: contained by `202608230003_bcrda_signal_integrity_containment.sql` when that migration is applied.

No claim is made that a favorable historical legacy dot was available at that historical time.
