import assert from "node:assert/strict";
import { calculateDDAProNative } from "../src/modules/dda-pro/core/nativeEngine.ts";
import { DEFAULT_DDA_PRO_SETTINGS } from "../src/modules/dda-pro/core/settings.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import type { DDAProTheme } from "../src/modules/dda-pro/core/types.ts";

function candles(values: readonly number[]): Candle[] {
  return values.map((close, index) => ({ time: 1_700_000_000 + index * 86_400, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1_000 }));
}

assert.equal(
  DEFAULT_DDA_PRO_SETTINGS.depthWeight + DEFAULT_DDA_PRO_SETTINGS.durationWeight + DEFAULT_DDA_PRO_SETTINGS.velocityWeight + DEFAULT_DDA_PRO_SETTINGS.volatilityWeight + DEFAULT_DDA_PRO_SETTINGS.tailWeight,
  1
);

{
  const result = calculateDDAProNative({ candles: candles([100, 120, 110, 90, 100, 115, 120]), settings: { ...DEFAULT_DDA_PRO_SETTINGS, lookback: 100, drawdownEpisodeThresholdPercent: 1 }, timeframeSeconds: 86_400 });
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0]?.recovered, true);
  assert.equal(result.episodes[0]?.troughIndex, 3);
  assert.ok((result.episodes[0]?.areaUnderWater ?? 0) > (result.episodes[0]?.depthPercent ?? 0));
}

{
  let seed = 0xdda2026;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x1_0000_0000);
  const values: number[] = [100];
  for (let index = 1; index < 5_000; index++) values.push(Math.max(1, values[index - 1]! * Math.exp((random() - 0.505) * 0.04)));
  const result = calculateDDAProNative({ candles: candles(values), settings: { ...DEFAULT_DDA_PRO_SETTINGS, lookback: 500 }, timeframeSeconds: 86_400 });
  for (const [key, series] of Object.entries(result.series)) {
    assert.equal(series.length, values.length, key + " length");
    if (key === "riskState") {
      assert.ok(series.every((value) => ["LOW", "MODERATE", "HIGH", "EXTREME", "INSUFFICIENT"].includes(String(value))), "riskState contains invalid output");
    } else {
      assert.ok(series.every((value) => Number.isFinite(value as number)), key + " contains non-finite output");
    }
  }
  assert.ok(result.series.rawDrawdown.every((value) => value <= 1e-10));
  assert.ok(result.series.depth.every((value) => value >= -1e-10));
  assert.ok(result.series.riskScore.every((value) => value >= 0 && value <= 100));
  assert.ok(result.latest.confidence >= 0 && result.latest.confidence <= 100);
  assert.ok(result.latest.returnVaR95Percent >= 0);
  assert.ok(result.latest.returnES95Percent + 1e-10 >= result.latest.returnVaR95Percent);
  assert.ok(result.latest.conditionalDrawdownAtRisk95Percent + 1e-10 >= result.latest.drawdownAtRisk95Percent);
  for (let index = 0; index < values.length; index++) {
    const ordered = [result.series.p05[index], result.series.p10[index], result.series.p25[index], result.series.p50[index], result.series.p75[index], result.series.p90[index], result.series.p95[index], result.series.p99[index]].map((value) => Math.abs(value ?? 0));
    assert.ok(ordered.every((value, position) => position === 0 || value + 1e-9 >= ordered[position - 1]!), `quantile order at ${index}`);
  }
}

{
  const source = candles(Array.from({ length: 240 }, (_, index) => 100 + Math.sin(index / 11) * 5));
  const base = calculateDDAProNative({ candles: source, settings: DEFAULT_DDA_PRO_SETTINGS, timeframeSeconds: 86_400 });
  for (const theme of ["black-terminal", "black-terminal-blood", "institutional-monochrome", "custom", "gold", "edge-tools", "behavioral", "quant", "ocean", "fire", "matrix", "arctic"] as DDAProTheme[]) {
    const themed = calculateDDAProNative({ candles: source, settings: { ...DEFAULT_DDA_PRO_SETTINGS, theme, lineIntensity: 12, showDashboard: false, showExpandedDashboard: true, dashboardPosition: "bottom-left" }, timeframeSeconds: 86_400 });
    assert.equal(themed.calculationHash, base.calculationHash, theme + " render settings changed the calculation hash");
    assert.equal(themed.dataHash, base.dataHash, theme + " render settings changed the data hash");
    assert.equal(themed.outputHash, base.outputHash, theme + " render settings changed the output hash");
    assert.notEqual(themed.settingsHash, base.settingsHash, theme + " full settings diagnostics ignored rendering changes");
    assert.deepEqual(themed.series, base.series, `${theme} render settings changed numerical output`);
  }
}

{
  const malformed = candles([100, 101, 102]);
  malformed[1] = { ...malformed[1]!, close: Number.NaN };
  const result = calculateDDAProNative({ candles: malformed, settings: { ...DEFAULT_DDA_PRO_SETTINGS, lookback: 100 }, timeframeSeconds: 86_400 });
  assert.equal(result.inputSize, 2);
  assert.match(result.sourceWarning ?? "", /malformed source bar/);
  assert.ok(result.latest.confidence < 100);
}

{
  const result = calculateDDAProNative({ candles: candles([100, 90, 95]), equityValues: undefined, settings: { ...DEFAULT_DDA_PRO_SETTINGS, equitySource: "connected-account" }, timeframeSeconds: 86_400 });
  assert.equal(result.sourceAuthority, "UNAVAILABLE");
  assert.equal(result.inputSize, 0);
  assert.match(result.sourceWarning ?? "", /not substituted/);
}

{
  const logReturns = Array.from({ length: 400 }, (_, index) => index % 2 === 0 ? 0.002 : -0.001);
  const values = [100];
  for (const point of logReturns) values.push(values.at(-1)! * Math.exp(point));
  const result = calculateDDAProNative({
    candles: candles(values),
    settings: { ...DEFAULT_DDA_PRO_SETTINGS, lookback: 400, riskFreeRatePercent: 4, annualizationMode: "crypto-365" },
    timeframeSeconds: 86_400
  });
  const barsPerYear = 365.25;
  const metricReturns = logReturns.slice(1);
  const average = metricReturns.reduce((sum, value) => sum + value, 0) / metricReturns.length;
  const deviation = Math.sqrt(metricReturns.reduce((sum, value) => sum + (value - average) ** 2, 0) / metricReturns.length);
  const expectedAnnualReturn = Math.expm1(average * barsPerYear) * 100;
  const expectedSharpe = (average - Math.log1p(0.04) / barsPerYear) / deviation * Math.sqrt(barsPerYear);
  assert.equal(result.barsPerYear, barsPerYear, "crypto annualization must retain the 365.25-day convention");
  assert.ok(Math.abs(result.latest.annualizedReturnPercent - expectedAnnualReturn) < 1e-9, "native annualized return must be geometric");
  assert.ok(Math.abs(result.latest.sharpe - expectedSharpe) < 1e-9, "native Sharpe must compare per-bar excess return in consistent units");
  const tailReturns = logReturns.slice(-400);
  const tailMean = tailReturns.reduce((sum, value) => sum + value, 0) / tailReturns.length;
  const tailVariance = tailReturns.reduce((sum, value) => sum + (value - tailMean) ** 2, 0) / tailReturns.length;
  const expectedVadd = result.latest.depthPercent / Math.max(Math.sqrt(tailVariance) * Math.sqrt(barsPerYear) * 100, result.latest.depthPercent ? DEFAULT_DDA_PRO_SETTINGS.vaddVolatilityFloorPercent : 0.10);
  assert.ok(Math.abs(result.latest.vadd - expectedVadd) < 1e-9, "VADD must normalize depth by annualized volatility percent");
}

console.log("BC-RDA conservation, episode, tail, hash-independence, and authority invariants: PASS");
