import assert from "node:assert/strict";
import { compileAndRunScript, extractScriptInputs, finalizedScriptResult } from "../src/components/ScriptCompiler.ts";
import type { Candle } from "../src/chart-engine/types.ts";

const candles: Candle[] = [
  { time: 1_800_000_000, open: 99, high: 101, low: 98, close: 100, volume: 1000 },
  { time: 1_800_000_060, open: 100, high: 108, low: 99.5, close: 107, volume: 1200 },
  { time: 1_800_000_120, open: 107, high: 107.5, low: 106, close: 106.5, volume: 1100 }
];

const sevenTargetStrategy = `# Black Script v3 partial-target certification
strategy(
  initial_capital=10000,
  default_qty_type=strategy.fixed,
  default_qty_value=10,
  commission_type=strategy.commission.percent,
  commission_value=0,
  slippage=0,
  tick_size=0.01,
  pyramiding=1,
  process_orders_on_close=True
)

long_signal = close > open
tp1 = strategy.position_avg_price + 1
tp2 = strategy.position_avg_price + 2
tp3 = strategy.position_avg_price + 3
tp4 = strategy.position_avg_price + 4
tp5 = strategy.position_avg_price + 5
tp6 = strategy.position_avg_price + 6
tp7 = strategy.position_avg_price + 7

strategy.entry("Core Long", strategy.long, when=long_signal)
strategy.exit("TP1", "Core Long", limit=tp1, qty_percent=10, when=strategy.position_size > 0)
strategy.exit("TP2", "Core Long", limit=tp2, qty_percent=10, when=strategy.position_size > 0)
strategy.exit("TP3", "Core Long", limit=tp3, qty_percent=10, when=strategy.position_size > 0)
strategy.exit("TP4", "Core Long", limit=tp4, qty_percent=10, when=strategy.position_size > 0)
strategy.exit("TP5", "Core Long", limit=tp5, qty_percent=10, when=strategy.position_size > 0)
strategy.exit("TP6", "Core Long", limit=tp6, qty_percent=10, when=strategy.position_size > 0)
strategy.exit("TP7", "Core Long", limit=tp7, qty_percent=10, when=strategy.position_size > 0)
plot(
  strategy.equity,
  title="Equity",
  color="#f4f4f5",
  width=2,
  pane="oscillator"
)`;

const sevenTarget = compileAndRunScript(sevenTargetStrategy, candles);
assert.equal(sevenTarget.success, true, JSON.stringify(sevenTarget.errors));
assert.ok(sevenTarget.strategy, "strategy report must be present");
assert.equal(sevenTarget.strategy.fills.filter((fill) => fill.action === "entry").length, 1, "persistent entry state must block duplicate same-side fills");
assert.equal(sevenTarget.strategy.fills.filter((fill) => fill.action === "exit").length, 7, "all seven independent take-profit orders must fill");
assert.equal(sevenTarget.strategy.trades.length, 7, "partial fills must produce independently auditable closed trades");
assert.ok(sevenTarget.strategy.trades.every((trade) => Math.abs(trade.quantity - 1) < 1e-10), "each 10% target must close 10% of the original ten-contract position");
assert.equal(sevenTarget.strategy.openPosition?.quantity, 3, "seven 10% targets must leave exactly 30% open");
assert.equal(sevenTarget.plots[0].values.length, candles.length, "multiline plot calls must compile without flattening output");

const conservativeBracket = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, process_orders_on_close=True)
enter = close > open
strategy.entry("Long", strategy.long, when=enter)
target = strategy.position_avg_price + 5
protection = strategy.position_avg_price - 5
strategy.exit("Bracket", "Long", limit=target, stop=protection, when=strategy.position_size > 0)`;
const ambiguousCandles: Candle[] = [
  { time: 1_810_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_810_000_060, open: 100, high: 106, low: 94, close: 102, volume: 100 }
];
const conservative = compileAndRunScript(conservativeBracket, ambiguousCandles);
assert.equal(conservative.success, true, JSON.stringify(conservative.errors));
assert.equal(conservative.strategy?.trades.length, 1);
assert.match(conservative.strategy?.trades[0].exitReason ?? "", /STOP$/, "when stop and target touch in one OHLC bar, the simulator must use the documented conservative stop-first path");
assert.equal(conservative.strategy?.trades[0].exitPrice, 95);

const reversalScript = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, commission_type=strategy.commission.percent, commission_value=1, slippage=1, tick_size=1)
long_signal = close > open
short_signal = close < open
strategy.entry("Long", strategy.long, when=long_signal)
strategy.entry("Short", strategy.short, when=short_signal)`;
const reversalCandles: Candle[] = [
  { time: 1_820_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_820_000_060, open: 101, high: 102, low: 98, close: 99, volume: 100 }
];
const reversal = compileAndRunScript(reversalScript, reversalCandles);
assert.equal(reversal.success, true, JSON.stringify(reversal.errors));
assert.equal(reversal.strategy?.fills.length, 3, "opposite entry must close the long exactly once before opening the short");
assert.equal(reversal.strategy?.trades.length, 1);
assert.equal(reversal.strategy?.trades[0].exitReason, "REVERSE:Short");
assert.equal(reversal.strategy?.openPosition?.side, "short");
assert.equal(reversal.strategy?.fills[0].price, 101, "entry slippage must be adverse to the buy");
assert.equal(reversal.strategy?.fills[1].price, 98, "exit slippage must be adverse to the sell");
assert.ok((reversal.strategy?.totalCommission ?? 0) > 0, "commission must be charged on every fill");

const nextOpenScript = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, process_orders_on_close=False)
signal = close > open
strategy.entry("Delayed", strategy.long, when=signal)`;
const nextOpenCandles: Candle[] = [
  { time: 1_830_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_830_000_060, open: 105, high: 106, low: 104, close: 105.5, volume: 100 }
];
const nextOpen = compileAndRunScript(nextOpenScript, nextOpenCandles);
assert.equal(nextOpen.success, true, JSON.stringify(nextOpen.errors));
assert.equal(nextOpen.strategy?.fills[0].index, 1);
assert.equal(nextOpen.strategy?.fills[0].price, 105, "market orders configured for next-bar execution must fill at the next open");

const finalizedReversal = finalizedScriptResult(reversal, reversalCandles[0].time);
assert.ok(finalizedReversal.strategy?.fills.every((fill) => fill.time <= reversalCandles[0].time));
assert.ok(finalizedReversal.strategy?.trades.every((trade) => trade.exitTime <= reversalCandles[0].time));

const tupleAndColor = `fast_color = input.color("#ffffff", "Fast Color")
[macd_line, signal_line, histogram] = ta.macd(close, 2, 3, 2)
prior_macd = macd_line[1]
selected = macd_line if close > open else prior_macd
plot(selected, title="MACD", color=fast_color, pane="oscillator")
plot(signal_line, title="Signal", color="#c40024", pane="oscillator")
plot(histogram, title="Histogram", color="#8d8d92", pane="oscillator")`;
const tupleResult = compileAndRunScript(tupleAndColor, candles);
assert.equal(tupleResult.success, true, JSON.stringify(tupleResult.errors));
assert.equal(tupleResult.plots.length, 3, "tuple destructuring must expose all MACD series");
assert.deepEqual(extractScriptInputs(tupleAndColor), [{
  key: "Fast Color",
  variable: "fast_color",
  label: "Fast Color",
  type: "color",
  defaultValue: "#ffffff"
}]);

const professionalInputs = `mode = input.string("Balanced", "Mode", options=["Fast", "Balanced", "Macro"], group="Engine", tooltip="Execution profile")
length = input.int(21, "Length", minval=2, maxval=500, step=1, group="Engine")
plot(ta.ema(close, length), title="Configured", color="#ffffff")`;
assert.deepEqual(extractScriptInputs(professionalInputs), [
  { key: "Mode", variable: "mode", label: "Mode", type: "string", defaultValue: "Balanced", options: ["Fast", "Balanced", "Macro"], group: "Engine", tooltip: "Execution profile" },
  { key: "Length", variable: "length", label: "Length", type: "int", defaultValue: 21, min: 2, max: 500, step: 1, group: "Engine" }
]);
const clampedInputs = compileAndRunScript(professionalInputs, candles, { Mode: "Not Allowed", Length: 9999 });
assert.equal(clampedInputs.success, true, JSON.stringify(clampedInputs.errors));

const prefix = compileAndRunScript(sevenTargetStrategy, candles.slice(0, 2));
assert.equal(prefix.success, true, JSON.stringify(prefix.errors));
assert.deepEqual(
  sevenTarget.strategy.positionSize.slice(0, 2),
  prefix.strategy?.positionSize,
  "future candles must not alter historical position state"
);
assert.deepEqual(
  sevenTarget.strategy.trades.filter((trade) => trade.exitIndex < 2).map((trade) => trade.exitPrice),
  prefix.strategy?.trades.map((trade) => trade.exitPrice),
  "future candles must not alter historical partial fills"
);

for (const unsafe of [
  "import os",
  "while True:\n  strategy.entry('x', strategy.long)",
  "open('/etc/passwd')",
  "fetch('https://example.com')"
]) {
  const result = compileAndRunScript(unsafe, candles);
  assert.equal(result.success, false, `sandbox escape unexpectedly compiled: ${unsafe}`);
}

console.log("Black Script v3 stateful strategy runtime: PASS");
