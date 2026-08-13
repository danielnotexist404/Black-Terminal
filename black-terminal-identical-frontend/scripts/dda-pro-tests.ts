import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateDDAProCompatibility } from "../src/modules/dda-pro/core/compatibilityEngine.ts";
import { calculateDDAProNative } from "../src/modules/dda-pro/core/nativeEngine.ts";
import { DEFAULT_DDA_PRO_SETTINGS } from "../src/modules/dda-pro/core/settings.ts";
import { quantile } from "../src/modules/dda-pro/core/statistics.ts";
import type { Candle } from "../src/chart-engine/types.ts";

function candles(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: 1_700_000_000 + index * 3_600,
    open: index ? closes[index - 1]! : close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 1_000 + index
  }));
}

const nativeSettings = { ...DEFAULT_DDA_PRO_SETTINGS, lookback: 100, smoothingMethod: "ema" as const };

{
  const result = calculateDDAProNative({ candles: candles(Array.from({ length: 240 }, (_, index) => 100 + index)), settings: nativeSettings, timeframeSeconds: 3_600 });
  assert.equal(result.latest.maxDrawdownPercent, 0, "monotonic equity must not invent drawdown");
  assert.equal(result.latest.riskState, "LOW");
  assert.equal(result.sourceAuthority, "MARKET_PRICE");
}

{
  const result = calculateDDAProNative({ candles: candles([100, 120, 108, 96, 102]), settings: { ...nativeSettings, lookback: 100, peakMode: "rolling" }, timeframeSeconds: 86_400 });
  assert.equal(result.series.rawDrawdown[2]!.toFixed(2), "-10.00");
  assert.equal(result.series.rawDrawdown[3]!.toFixed(2), "-20.00");
  assert.equal(result.latest.maxDrawdownPercent.toFixed(2), "20.00");
}

{
  assert.equal(quantile([0, 10, 20, 30], 0.25, "type7"), 7.5);
  assert.equal(quantile([0, 10, 20, 30], 0.25, "nearest-rank"), 0);
}

{
  const source = candles(Array.from({ length: 480 }, (_, index) => 100 + Math.sin(index / 13) * 8 + index * 0.02));
  const prefix = calculateDDAProNative({ candles: source.slice(0, 360), settings: nativeSettings, timeframeSeconds: 3_600 });
  const full = calculateDDAProNative({ candles: source, settings: nativeSettings, timeframeSeconds: 3_600 });
  for (const key of ["rawDrawdown", "smoothedDrawdown", "p95", "riskScore", "riskState"] as const) {
    assert.deepEqual(full.series[key].slice(0, 360), prefix.series[key], `${key} repainted after future bars were appended`);
  }
}

{
  const prices = [...Array.from({ length: 160 }, (_, index) => 100 + index * 0.2), ...Array.from({ length: 80 }, (_, index) => 132 * (1 - index * 0.006))];
  const result = calculateDDAProNative({ candles: candles(prices), settings: { ...nativeSettings, smoothingLength: 3 }, timeframeSeconds: 3_600 });
  const eventTypes = new Set(result.events.map((event) => event.type));
  for (const eventType of ["DDA_RISK_SCORE_CROSSED_50", "DDA_RISK_SCORE_CROSSED_75", "DDA_RISK_SCORE_CROSSED_90", "DDA_P90_ENTERED", "DDA_P95_ENTERED", "DDA_P99_ENTERED", "DDA_CDAR_BREACHED", "DDA_RISK_DETERIORATION_ACCELERATED"] as const) {
    assert.ok(eventTypes.has(eventType), `${eventType} was not emitted by deterministic crash history`);
  }
  for (const event of result.events) {
    assert.equal(event.engineMode, "black-core-native");
    assert.equal(event.sourceAuthority, "MARKET_PRICE");
    assert.equal(event.lookback, 100);
    assert.ok(Number.isFinite(event.riskScore));
    assert.ok(Number.isFinite(event.drawdownPercent));
  }
}

{
  const prices = [...Array.from({ length: 150 }, (_, index) => 100 + index), ...Array.from({ length: 200 }, (_, index) => 249 - index * 0.05)];
  const compatibility = calculateDDAProCompatibility({ candles: candles(prices), settings: { ...nativeSettings, engineMode: "pine-compatibility", lookback: 100 }, timeframeSeconds: 86_400 });
  const native = calculateDDAProNative({ candles: candles(prices), settings: { ...nativeSettings, lookback: 100 }, timeframeSeconds: 86_400 });
  assert.ok(Math.abs(compatibility.latest.drawdownPercent) > Math.abs(native.latest.drawdownPercent), "compatibility must retain the Pine all-history peak while native uses a rolling peak");
  assert.equal(compatibility.validFromIndex, 100);
  assert.ok(Number.isNaN(compatibility.series.p50[99]!), "compatibility distribution rendered before Pine validBars");
  assert.ok(Number.isFinite(compatibility.series.p50[100]!), "compatibility distribution did not begin at Pine validBars");
}

{
  const first = candles([100, 110, 90, 105]);
  const second = candles([100, 95, 90, 105]);
  const firstResult = calculateDDAProNative({ candles: first, settings: nativeSettings, timeframeSeconds: 3_600 });
  const secondResult = calculateDDAProNative({ candles: second, settings: nativeSettings, timeframeSeconds: 3_600 });
  assert.notEqual(firstResult.calculationHash, secondResult.calculationHash, "full-history calculation fingerprint ignored interior source changes");
  assert.notEqual(firstResult.dataHash, secondResult.dataHash, "data diagnostics ignored interior source changes");
  assert.equal(firstResult.settingsHash, secondResult.settingsHash, "identical settings produced different settings hashes");
  assert.notEqual(firstResult.outputHash, secondResult.outputHash, "output diagnostics ignored changed numerical results");
}

{
  const source = readFileSync(new URL("../reference/pine/dda-pro-edgetools-v6.pine", import.meta.url), "utf8");
  assert.match(source, /Mozilla Public License 2\.0/);
  assert.match(source, /runningPeak := math\.max\(runningPeak, dataSource\)/);
  assert.match(source, /ta\.percentile_nearest_rank/);
  assert.match(source, /\* 252 \* 100/);
  assert.match(source, /showDistributionInfo/);
  const chartSource = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
  const alertSource = readFileSync(new URL("../src/components/AlertCenter.tsx", import.meta.url), "utf8");
  const engineSource = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
  assert.match(chartSource, /alertBarIsConfirmed/);
  assert.match(chartSource, /ddaProCalculationHash\(\{ candles: source/);
  assert.match(chartSource, /setDDAProSourceRevision/);
  assert.match(engineSource, /NEAREST TAIL/);
  assert.match(chartSource, /showExpandedDashboard/);
  assert.match(chartSource, /definition\.indicator === "ddaPro"/);
  assert.match(alertSource, /DDA_RISK_SCORE_CROSSED_90/);
  assert.doesNotMatch(chartSource, /placeOrder|submitOrder|cancelOrder/);
}

console.log("DDA Pro deterministic, statistics, compatibility, and no-lookahead tests: PASS");
