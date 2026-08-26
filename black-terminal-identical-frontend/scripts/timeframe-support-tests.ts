import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateCandlesToTimeframe,
  buildCandlesFromTrades,
  CandleAggregationEngine,
  isTradeBuiltTimeframe,
  requiresTradeSynthesis
} from "../src/market-data/aggregation/candleAggregator.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import type { Timeframe, TradeTick } from "../src/market-data/types.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function trade(index: number, time: number, price = 100 + index, quantity = 1): TradeTick {
  return {
    exchange: "bybit",
    symbol: "BTCUSDT",
    tradeId: `trade-${index}`,
    time,
    price,
    quantity,
    side: index % 2 ? "sell" : "buy"
  };
}

{
  const engine = new CandleAggregationEngine();
  const first = engine.ingestTrade(trade(1, 1_700_000_001, 101), "10s");
  const second = engine.ingestTrade(trade(2, 1_700_000_009, 99), "10s");
  const third = engine.ingestTrade(trade(3, 1_700_000_011, 105), "10s");
  assert.equal(first?.candle.time, 1_700_000_000, "10-second candles must bucket epoch seconds without dividing by 1000 twice");
  assert.equal(second?.candle.low, 99);
  assert.equal(third?.closed?.time, 1_700_000_000);
  assert.equal(third?.candle.time, 1_700_000_010);
}

{
  const candles = buildCandlesFromTrades([
    trade(4, 1_700_000_001, 101),
    trade(5, 1_700_000_012, 102),
    trade(6, 1_700_000_045, 103)
  ], "30s");
  assert.deepEqual(candles.map((candle) => candle.time), [1_699_999_980, 1_700_000_010, 1_700_000_040]);
}

for (const timeframe of ["1s", "10s", "30s", "1t", "10t", "100t"] as Timeframe[]) {
  assert.equal(isTradeBuiltTimeframe(timeframe), true, `${timeframe} must use genuine public trades rather than an unsupported kline request`);
  assert.equal(requiresTradeSynthesis(timeframe), true);
}
assert.equal(requiresTradeSynthesis("3h"), true, "3H live candles must be synthesized from trades because venues do not expose a native 3H stream");

{
  const oneTick = buildCandlesFromTrades([
    trade(10, 1_700_000_100, 100),
    trade(11, 1_700_000_100, 101),
    trade(12, 1_700_000_100, 102)
  ], "1t");
  assert.equal(oneTick.length, 3, "one-trade candles must retain every genuine trade");
  assert.ok(oneTick[1]!.time > oneTick[0]!.time && oneTick[2]!.time > oneTick[1]!.time, "same-second tick candles need stable monotonic chart identities");

  const tenTickTrades = Array.from({ length: 21 }, (_, index) => trade(index + 20, 1_700_000_200 + Math.floor(index / 4), 100 + index));
  const tenTick = buildCandlesFromTrades(tenTickTrades, "10t");
  assert.equal(tenTick.length, 3, "21 trades must create two closed 10-tick candles and one developing candle");
  assert.equal(tenTick[0]!.volume, 10);
  assert.equal(tenTick[1]!.volume, 10);
  assert.equal(tenTick[2]!.volume, 1);

  const hundredTick = buildCandlesFromTrades(Array.from({ length: 200 }, (_, index) => trade(index + 100, 1_700_001_000 + index, 100)), "100t");
  assert.equal(hundredTick.length, 2);
  assert.equal(hundredTick.every((candle) => candle.volume === 100), true);
}

{
  const hourly: Candle[] = Array.from({ length: 6 }, (_, index) => ({
    time: 1_699_995_600 + index * 3_600,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index
  }));
  const threeHour = aggregateCandlesToTimeframe(hourly, "3h");
  assert.equal(threeHour.length, 2);
  assert.deepEqual(threeHour.map((candle) => candle.time), [1_699_995_600, 1_700_006_400]);
  assert.equal(threeHour[0]!.open, 100);
  assert.equal(threeHour[0]!.close, 103);
  assert.equal(threeHour[0]!.volume, 33);
}

{
  const app = readFileSync(resolve(projectRoot, "src/App.tsx"), "utf8");
  const settings = readFileSync(resolve(projectRoot, "src/components/SettingsPanel.tsx"), "utf8");
  const chart = readFileSync(resolve(projectRoot, "src/components/PixiBlackChart.tsx"), "utf8");
  for (const timeframe of ["1s", "3m", "2h", "3h", "6h", "12h", "1t", "10s", "30s"]) {
    assert.match(app, new RegExp(`value: ["']${timeframe}["']`), `${timeframe} is missing from the chart selector`);
    assert.match(settings, new RegExp(`value: ["']${timeframe}["']`), `${timeframe} is missing from workspace settings`);
  }
  assert.match(chart, /loadTradeBuiltHistory\(\)/, "trade-built timeframes must receive an initial genuine-trade candle seed");
  assert.match(chart, /tradeSynthesizedTimeframe\s*\?\s*undefined/, "unsupported live kline subscriptions must remain disabled");
}

console.log("Timeframe support tests passed: native, derived, sub-minute, and tick candle contracts are valid.");
