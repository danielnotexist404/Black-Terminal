# DDA Pro Pine audit

Source: `reference/pine/dda-pro-edgetools-v6.pine`, retained verbatim under MPL-2.0 with EdgeTools attribution.

| Pine lines | Block | Exact source behavior | State/input | Compatibility implementation | Native treatment | Status / fixture |
|---|---|---|---|---|---|---|
| 49–55 | Core inputs | 500-bar lookback, EMA 14, selected price source | User inputs | Forced EMA, source, nearest-rank lookback | 100–20,000 bars, selectable smoothing/source | Source-audited; synthetic fixtures pass |
| 57–111 | Display/risk/theme inputs | Percentile/sigma fills; thresholds 50/75/90; eight themes | User inputs | Legacy plot semantics and theme selector retained | Black Terminal themes and 50/75/90 score states | TradingView visual golden absent |
| 225–248 | Peak/drawdown | Persistent all-history `runningPeak`; unused rolling `maxPeakInPeriod`; drawdown `(source-peak)/peak*100`; EMA | `var` running peak | All-history peak and EMA | All-history or rolling peak; raw depth drives risk | Known-drawdown and future-append fixtures pass |
| 250–257 | Readiness/risk-free | Valid on `bar_index >= lookback`; fixed or US10Y daily, fallback fixed | External daily series | Fixed rate supported; external series unavailable is documented | Fixed annual rate; future external provider not claimed | External US10Y parity not certified |
| 263–300 | Distribution | SMA/population stdev; nearest-rank P5/10/25/50/75/90/95; percent rank; 1/2/3 sigma | Rolling smoothed DD | Same signed smoothed distribution | Positive raw depth, type-7 or nearest-rank, classical or MAD z-score | Quantile fixtures and Python mirror pass |
| 306–328 | Classification | Rank ≥50 Low, ≥25 Moderate, ≥10 High, else Extreme; absolute z thresholds 2.5/3; rolling lowest smoothed DD | Rolling | Legacy direction retained | Transparent score with 50/75/90 states and hysteresis | State tests are deterministic; TV golden absent |
| 330–365 | Recovery/performance | Recovery from rolling lowest price; log returns; 252 annualization; Sharpe/Sortino/Calmar; VADD uses annual volatility/20 | Rolling | Original assumptions retained where represented | Episode recovery, 365 crypto default, proper raw MDD metrics | Native metric invariants pass |
| 367–388 | “VaR”/CVaR/efficiency | P5/P1 smoothed drawdown labeled VaR; mean P1…P5 labeled CVaR; `(Sharpe*10+rank)/2` | Rolling | Legacy labels/formulas retained as compatibility semantics | Return VaR/ES are separate from DaR/CDaR | Known Pine anomaly documented |
| 390–404 | Duration | Persistent counter starts at 1 below smoothed -1%; leaving drawdown does not reset stored counter; rolling highest | Persistent variables | Counter persistence retained | Episode duration and time-under-water reset causally | Source-audited fixture |
| 407–570 | Plots/table | Wave, percentile/sigma fills, optional VADD, compact 9-row table | Last bar | Renderer exposes compatibility wave/dashboard | Pixi fan, marker, episodes, risk strip/dashboard | Screenshot certification pending |
| 575–619 | Alerts | Risk/z/MDD/Sharpe/efficiency conditions | Bar transitions | Read-only state/extreme/recovery events | Typed read-only DDA events; no broker route | Alert Center signal registration and confirmation gate pass source contracts |

Known source anomalies: `maxPeakInPeriod` and `showDistributionInfo` are calculated/read but do not affect the main result; the alert text references a Z-Score plot that is not declared; “VaR” and “CVaR” are drawdown percentiles, not return loss measures; 252 is hard-coded; duration is not cleared outside an episode. Compatibility intentionally does not rewrite these semantics. Exact TradingView parity remains **UNVERIFIED** until golden exports for the required fixtures are supplied.
