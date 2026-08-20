import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Candle } from "../src/chart-engine/types.ts";
import type { CanonicalTrade } from "../src/modules/auction-profile/core/types.ts";
import { blankSeries } from "../src/modules/dda-pro/core/engineShared.ts";
import { calculateDDAProFlowPressure } from "../src/modules/dda-pro/core/flowPressure.ts";
import { DEFAULT_DDA_PRO_SETTINGS } from "../src/modules/dda-pro/core/settings.ts";
import type { DDAProFlowBarInput } from "../src/modules/dda-pro/core/types.ts";
import { buildDDAProFlowInput } from "../src/modules/dda-pro/data/flowPressureSource.ts";
import { ddaProSigmaUnit, nearestDDAProTailLabel } from "../src/modules/dda-pro/rendering/diagnostics.ts";

const start = 1_700_000_000;
const candles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
  time: start + index * 60,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10
}));

function trade(index: number, side: "BUY" | "SELL", source: CanonicalTrade["source"] = "EXCHANGE_AGGRESSOR_FLAG"): CanonicalTrade {
  return {
    venue: "bybit",
    symbol: "BTCUSDT",
    timestamp: start + index * 60 + 10,
    tradeId: `${index}:${side}:${source}`,
    price: 100,
    quantity: 2,
    notional: 200,
    aggressorSide: side,
    source,
    receivedAt: start + index * 60 + 10.1
  };
}

{
  const input = buildDDAProFlowInput({
    candles,
    trades: [trade(0, "BUY"), trade(1, "SELL"), trade(2, "BUY", "INFERRED")],
    timeframeSeconds: 60,
    captureStartedAt: start + 30,
    streamHealthy: true
  });
  assert.equal(input.flowBars[0]?.deliveryComplete, false, "mid-bar capture was incorrectly promoted to complete flow history");
  assert.equal(input.flowBars[1]?.deliveryComplete, true);
  assert.equal(input.flowBars[1]?.sellNotional, 200);
  assert.equal(input.flowBars[2]?.unknownNotional, 200, "inferred trade side entered the signed pressure calculation");
  assert.ok(Number.isNaN(input.cvdValues[0]!));
  assert.equal(input.cvdValues[1], -2);
}

function bars(direction: "BUY" | "SELL" | "BALANCED", length = 40): DDAProFlowBarInput[] {
  return Array.from({ length }, (_, index) => {
    const buyNotional = direction === "SELL" ? 0 : direction === "BALANCED" ? 100 : 200;
    const sellNotional = direction === "BUY" ? 0 : direction === "BALANCED" ? 100 : 200;
    const buyVolume = buyNotional / 100;
    const sellVolume = sellNotional / 100;
    return {
      time: start + index * 60,
      buyVolume,
      sellVolume,
      unknownVolume: 0,
      buyNotional,
      sellNotional,
      unknownNotional: 0,
      exactTradeCount: direction === "BALANCED" ? 2 : 1,
      totalTradeCount: direction === "BALANCED" ? 2 : 1,
      deliveryComplete: true
    };
  });
}

function calculate(flowBars: DDAProFlowBarInput[]) {
  const inputCandles = candles.slice(0, flowBars.length);
  const series = blankSeries(flowBars.length);
  const result = calculateDDAProFlowPressure({
    candles: inputCandles,
    settings: DEFAULT_DDA_PRO_SETTINGS,
    timeframeSeconds: 60,
    flowBars,
    flowAuthority: "EXACT_AGGRESSOR_TRADES"
  }, series);
  return { result, series };
}

{
  const bullish = calculate(bars("BUY"));
  const bearish = calculate(bars("SELL"));
  const neutral = calculate(bars("BALANCED"));
  assert.equal(bullish.result.authority, "EXACT_AGGRESSOR_TRADES");
  assert.equal(bullish.series.flowState.at(-1), "BULLISH");
  assert.ok((bullish.series.flowPressure.at(-1) ?? 0) > 0);
  assert.equal(bearish.series.flowState.at(-1), "BEARISH");
  assert.ok((bearish.series.flowPressure.at(-1) ?? 0) < 0);
  assert.equal(neutral.series.flowState.at(-1), "NEUTRAL");
  assert.equal(neutral.series.flowPressure.at(-1), 0);
}

{
  const contaminated = bars("BUY");
  contaminated[10] = { ...contaminated[10]!, unknownNotional: 200, totalTradeCount: 2 };
  const { series } = calculate(contaminated.slice(0, 11));
  assert.equal(series.flowState[10], "UNAVAILABLE", "sub-threshold aggressor classification coverage did not fail closed");
}

{
  const full = calculate(bars("BUY", 40)).series;
  const prefix = calculate(bars("BUY", 30)).series;
  assert.deepEqual(full.flowPressure.slice(0, 30), prefix.flowPressure, "future flow bars repainted the causal pressure series");
  assert.deepEqual(full.flowState.slice(0, 30), prefix.flowState, "future flow bars repainted pressure states");
}

{
  const unavailable = blankSeries(2);
  const result = calculateDDAProFlowPressure({ candles: candles.slice(0, 2), settings: DEFAULT_DDA_PRO_SETTINGS, flowAuthority: "UNAVAILABLE" }, unavailable);
  assert.equal(result.authority, "UNAVAILABLE");
  assert.ok(unavailable.flowState.every((state) => state === "UNAVAILABLE"));
}

{
  const series = blankSeries(1);
  series.p05[0] = -20; series.p10[0] = -15; series.p25[0] = -10; series.p50[0] = -5;
  series.p75[0] = -5; series.p90[0] = -10; series.p95[0] = -15; series.p99[0] = -20;
  assert.equal(nearestDDAProTailLabel("black-core-native", series, 0, 21), "P99");
  assert.equal(nearestDDAProTailLabel("pine-compatibility", series, 0, 21), "P05");
  assert.equal(nearestDDAProTailLabel("black-core-native", series, 0, 0), "P50", "zero drawdown was mislabeled P99");
  assert.equal(ddaProSigmaUnit(-4, -8, 0, 2, false), 2);
  assert.equal(ddaProSigmaUnit(-4, -8, 0, 2, true), 2);
}

{
  const chart = readFileSync(new URL("../src/components/PixiBlackChart.tsx", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/chart-engine/BlackChartEngine.ts", import.meta.url), "utf8");
  const bybit = readFileSync(new URL("../src/market-data/adapters/bybit.ts", import.meta.url), "utf8");
  assert.match(chart, /buildDDAProFlowInput/);
  assert.match(chart, /continuous genuine aggressor-trade stream/);
  assert.match(renderer, /snapshot\.series\.flowPressure/);
  assert.match(renderer, /settings\.flowBullishColor/);
  assert.match(renderer, /settings\.flowBearishColor/);
  assert.match(renderer, /nearestDDAProTailLabel/);
  assert.match(bybit, /publicTrade\.\$\{normalizedSymbol\}/);
  assert.match(bybit, /aggressorSource: "EXCHANGE_AGGRESSOR_FLAG"/);
  assert.doesNotMatch(renderer, /quantileColors[\s\S]{0,200}flowPressure/, "flow pressure was merged into the risk-fan palette");
}

console.log("BC-RDA genuine flow-pressure, fail-closed coverage, no-lookahead, tail orientation, and render separation tests: PASS");
