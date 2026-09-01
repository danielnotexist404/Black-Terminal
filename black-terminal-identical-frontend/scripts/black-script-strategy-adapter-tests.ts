import assert from "node:assert/strict";
import { runBlackScriptBacktest } from "../src/modules/strategy-lab/adapters/pythonStrategyAdapter.ts";
import type { BacktestConfig } from "../src/modules/strategy-lab/types/backtest.types.ts";
import type { Candle } from "../src/chart-engine/types.ts";
import { defaultStrategySettings } from "../src/modules/strategy-lab/types/strategy.types.ts";

const candles: Candle[] = [
  { time: 1_900_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_900_000_060, open: 100, high: 106, low: 99, close: 105, volume: 120 },
  { time: 1_900_000_120, open: 105, high: 106, low: 104, close: 105, volume: 90 },
];
const config: BacktestConfig = {
  symbol: "BTCUSDT",
  rawSymbol: "BTCUSDT",
  exchange: "bybit",
  exchangeLabel: "Bybit",
  marketKind: "perpetual",
  timeframe: "1m",
  startDate: "",
  endDate: "",
  initialCapital: 5_000,
  riskPerTrade: 0.01,
  feeRate: 0,
  slippageTicks: 0,
  tickSize: 0.01,
  spreadBps: 0,
  useBidAskExecution: false,
  strategyKind: "python-script",
  strategySettings: defaultStrategySettings,
};
const source = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, process_orders_on_close=True)
distance = input.float(5, "Target Distance")
strategy.entry("Long", strategy.long, when=close > open)
target = strategy.position_avg_price + distance
strategy.exit("TP1", "Long", limit=target, qty_percent=50, when=strategy.position_size > 0)`;

const result = runBlackScriptBacktest({
  source,
  candles,
  config,
  inputValues: { "Target Distance": 5 },
  runtimeConfig: {
    initialCapital: 5_000,
    defaultQuantityMode: "fixed",
    defaultQuantityValue: 2,
    historicalFillMode: "tradingview",
  },
});
assert.equal(result.trades.length, 1, "the shared runtime must preserve the script's partial exit instead of resimulating a generic signal");
assert.equal(result.trades[0]?.quantity, 1, "the saved runtime sizing override must produce a 50% partial close of two contracts");
assert.equal(result.trades[0]?.exitPrice, 105);
assert.equal(result.equityCurve.length, candles.length);
assert.equal(result.settings.runtimeVersion, "black-script-v3");
assert.equal((result.settings.runtime as { initialCapital: number }).initialCapital, 5_000);

assert.throws(
  () => runBlackScriptBacktest({ source: "plot(close)", candles, config }),
  /indicator/i,
  "indicators cannot silently masquerade as executable strategies",
);

console.log("Black Script Strategy Lab adapter tests PASS — shared fills, inputs, sizing, partial exits and fail-closed indicator handling verified.");
