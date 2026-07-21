import assert from "node:assert/strict";
import type { Candle } from "../src/chart-engine/types";
import type { MarketSymbol, Timeframe } from "../src/market-data/types";
import { evaluateConditionGroup, validateScanConfig } from "../src/modules/scanner/engine/ruleEvaluator";
import { ScannerEngine, sortResults } from "../src/modules/scanner/engine/scannerEngine";
import type { ScanConfig, ScannerConditionGroup, ScannerDataAdapter, ScannerResult } from "../src/modules/scanner/types/scanner.types";

function candles(count = 80): Candle[] {
  return Array.from({ length: count }).map((_, index) => {
    const close = index < count - 1 ? 100 + index : 181;
    return {
      time: 1_700_000_000 + index * 60,
      open: close - 0.7,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000 + index * 10
    };
  });
}

const symbol: MarketSymbol = {
  exchange: "binance",
  rawSymbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  marketKind: "perpetual"
};

function group(rules: ScannerConditionGroup["rules"], type: ScannerConditionGroup["type"] = "AND"): ScannerConditionGroup {
  return { id: "g", type, rules };
}

function baseConfig(conditions: ScannerConditionGroup): ScanConfig {
  return {
    id: "test",
    name: "Test Scan",
    universe: { type: "manual", symbols: ["BTCUSDT"] },
    timeframes: ["1m"],
    refreshMode: "manual",
    refreshIntervalSeconds: 60,
    maxResults: 50,
    sortBy: "score",
    sortDirection: "desc",
    conditions,
    scoring: { enabled: true }
  };
}

function ctx(source = candles()) {
  return {
    candles: source,
    index: source.length - 1,
    symbol,
    timeframe: "1m" as Timeframe,
    indicatorCache: new Map<string, number[]>()
  };
}

async function run() {
  const source = candles();

  for (const [operator, expected] of [
    [">", true],
    ["<", false],
    [">=", true],
    ["<=", false]
  ] as const) {
    const result = evaluateConditionGroup(group([{
      id: `op-${operator}`,
      label: `op ${operator}`,
      left: { type: "price", field: "close" },
      operator,
      right: { type: "constant", value: 150 }
    }]), ctx(source));
    assert.equal(result.matched, expected, operator);
  }

  assert.equal(evaluateConditionGroup(group([{
    id: "between",
    label: "between",
    left: { type: "indicator", name: "RSI", params: { period: 14 } },
    operator: "between",
    right: { type: "constant", value: 50 },
    right2: { type: "constant", value: 100 }
  }]), ctx(source)).matched, true);

  const crossUp = source.map((candle, index) => index === source.length - 2 ? { ...candle, close: 119 } : candle);
  assert.equal(evaluateConditionGroup(group([{
    id: "cross-up",
    label: "cross up",
    left: { type: "price", field: "close" },
    operator: "crosses_above",
    right: { type: "indicator", name: "HIGHEST_HIGH", params: { period: 20, includeCurrent: false } }
  }]), ctx(crossUp)).matched, true);

  const crossDown = source.map((candle, index) => ({ ...candle, close: index === source.length - 1 ? 50 : 100 + index, low: index === source.length - 1 ? 49 : 99 + index }));
  assert.equal(evaluateConditionGroup(group([{
    id: "cross-down",
    label: "cross down",
    left: { type: "price", field: "close" },
    operator: "crosses_below",
    right: { type: "indicator", name: "LOWEST_LOW", params: { period: 20, includeCurrent: false } }
  }]), ctx(crossDown)).matched, true);

  assert.equal(evaluateConditionGroup(group([
    { id: "ema", label: "EMA", left: { type: "price", field: "close" }, operator: ">", right: { type: "indicator", name: "EMA", params: { period: 20 } } },
    { id: "vol", label: "Volume SMA", left: { type: "price", field: "volume" }, operator: ">", right: { type: "indicator", name: "VOLUME_SMA", params: { period: 20 } } }
  ]) as ScannerConditionGroup, ctx(source)).matched, true);

  assert.equal(evaluateConditionGroup(group([
    { id: "bad", label: "bad", left: { type: "price", field: "close" }, operator: "<", right: { type: "constant", value: 1 } },
    { id: "good", label: "good", left: { type: "price", field: "close" }, operator: ">", right: { type: "constant", value: 1 } }
  ], "OR"), ctx(source)).matched, true);

  const sorted = sortResults([
    result("A", 20, 2),
    result("B", 90, 1),
    result("C", 50, 3)
  ], { ...baseConfig(group([])), sortBy: "score", sortDirection: "desc" });
  assert.deepEqual(sorted.map((item) => item.symbol), ["B", "C", "A"]);

  assert.equal(validateScanConfig({ ...baseConfig(group([])), timeframes: [] }).valid, false);

  const adapter: ScannerDataAdapter = {
    fetchCandles: async (nextSymbol) => {
      if (nextSymbol.rawSymbol === "BADUSDT") throw new Error("symbol failed");
      return source;
    }
  };
  const engine = new ScannerEngine(adapter);
  const output = await engine.runScan(baseConfig(group([{
    id: "pass",
    label: "pass",
    left: { type: "price", field: "close" },
    operator: ">",
    right: { type: "constant", value: 1 }
  }])), [symbol, { ...symbol, rawSymbol: "BADUSDT", baseAsset: "BAD" }], { concurrency: 2 });
  assert.equal(output.results.length, 1);
  assert.equal(output.errors.length, 1);

  const abort = new AbortController();
  abort.abort();
  const cancelled = await engine.runScan(baseConfig(group([{
    id: "pass2",
    label: "pass2",
    left: { type: "price", field: "close" },
    operator: ">",
    right: { type: "constant", value: 1 }
  }])), [symbol], { signal: abort.signal });
  assert.equal(cancelled.cancelled, true);

  console.log("scannerCore tests passed");
}

function result(symbolName: string, score: number, relativeVolume: number): ScannerResult {
  return {
    id: symbolName,
    status: "match",
    symbol: symbolName,
    displayName: symbolName,
    rawSymbol: symbolName,
    exchange: "binance",
    marketKind: "perpetual",
    timeframe: "1m",
    lastPrice: 1,
    changePercent: 1,
    volume: 1,
    relativeVolume,
    matchedConditions: [],
    score,
    updatedAt: 1
  };
}

void run();
