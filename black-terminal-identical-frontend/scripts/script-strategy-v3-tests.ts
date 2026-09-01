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
const sevenTargetFillMarkers = sevenTarget.markers.filter((marker) => marker.kind === "entry" || marker.kind === "exit");
assert.deepEqual(
  sevenTargetFillMarkers.map((marker) => marker.label),
  ["Long", "TP1", "TP2", "TP3", "TP4", "TP5", "TP6", "TP7"],
  "every actual strategy fill must carry a concise, sequential chart label"
);
assert.deepEqual(
  sevenTargetFillMarkers.map((marker) => marker.strategyRole),
  ["entry", "takeProfit", "takeProfit", "takeProfit", "takeProfit", "takeProfit", "takeProfit", "takeProfit"]
);
assert.ok(sevenTargetFillMarkers.every((marker) => marker.direction === "long"), "partial exits must preserve the side being exited for correct label placement");

const conservativeBracket = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, process_orders_on_close=True, historical_fill_mode="conservative")
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
assert.deepEqual(
  conservative.markers.filter((marker) => marker.kind === "entry" || marker.kind === "exit").map((marker) => [marker.label, marker.strategyRole]),
  [["Long", "entry"], ["SL", "stopLoss"], ["Long", "entry"]],
  "protective fills must be visibly distinct from take profits"
);

const tradingViewBracket = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, process_orders_on_close=True)
enter = close > open
strategy.entry("Long", strategy.long, when=enter)
target = strategy.position_avg_price + 5
protection = strategy.position_avg_price - 5
strategy.exit("Bracket", "Long", limit=target, stop=protection, when=strategy.position_size > 0)`;
const highFirstCandles: Candle[] = [
  { time: 1_811_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_811_000_060, open: 104, high: 106, low: 94, close: 102, volume: 100 }
];
const highFirst = compileAndRunScript(tradingViewBracket, highFirstCandles);
assert.equal(highFirst.success, true, JSON.stringify(highFirst.errors));
assert.match(highFirst.strategy?.trades[0]?.exitReason ?? "", /LIMIT$/, "TradingView's high-first four-tick path must reach the target before the stop");
assert.equal(highFirst.strategy?.trades[0]?.exitPrice, 105);

const lowFirstCandles: Candle[] = [
  { time: 1_812_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_812_000_060, open: 96, high: 106, low: 94, close: 102, volume: 100 }
];
const lowFirst = compileAndRunScript(tradingViewBracket, lowFirstCandles);
assert.equal(lowFirst.success, true, JSON.stringify(lowFirst.errors));
assert.match(lowFirst.strategy?.trades[0]?.exitReason ?? "", /STOP$/, "TradingView's low-first four-tick path must reach the stop before the target");
assert.equal(lowFirst.strategy?.trades[0]?.exitPrice, 95);

const magnifiedBracket = tradingViewBracket.replace(")\nenter", ", use_bar_magnifier=True)\nenter");
const magnified = compileAndRunScript(magnifiedBracket, highFirstCandles, {}, {
  intrabars: [undefined, [
    { time: 1_811_000_070, open: 104, high: 104.5, low: 94, close: 96, volume: 50 },
    { time: 1_811_000_080, open: 96, high: 106, low: 95.5, close: 102, volume: 50 }
  ]]
});
assert.equal(magnified.success, true, JSON.stringify(magnified.errors));
assert.match(magnified.strategy?.trades[0]?.exitReason ?? "", /STOP$/, "bar magnifier must use chronological lower-timeframe candles instead of the parent OHLC path");
assert.equal(magnified.strategy?.trades[0]?.exitTime, 1_811_000_070, "magnified fills retain the authoritative lower-timeframe timestamp");

const reversalScript = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, commission_type=strategy.commission.percent, commission_value=1, slippage=1, tick_size=1)
long_signal = close > open
short_signal = close < open
strategy.entry("Long", strategy.long, when=long_signal)
strategy.entry("Short", strategy.short, when=short_signal)`;
const reversalCandles: Candle[] = [
  { time: 1_820_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_820_000_060, open: 101, high: 102, low: 98, close: 99, volume: 100 },
  { time: 1_820_000_120, open: 98, high: 99, low: 96, close: 97, volume: 100 }
];
const reversal = compileAndRunScript(reversalScript, reversalCandles);
assert.equal(reversal.success, true, JSON.stringify(reversal.errors));
assert.equal(reversal.strategy?.fills.length, 3, "opposite entry must close the long exactly once before opening the short");
assert.equal(reversal.strategy?.trades.length, 1);
assert.equal(reversal.strategy?.trades[0].exitReason, "REVERSE:Short");
assert.equal(reversal.strategy?.openPosition?.side, "short");
assert.equal(reversal.strategy?.fills[0].price, 102, "the default one-tick-delayed entry fills at the next open with adverse buy slippage");
assert.equal(reversal.strategy?.fills[1].price, 97, "the delayed reversal exit fills at the following open with adverse sell slippage");
assert.ok((reversal.strategy?.totalCommission ?? 0) > 0, "commission must be charged on every fill");
assert.deepEqual(
  reversal.markers.filter((marker) => marker.kind === "entry" || marker.kind === "exit").map((marker) => [marker.label, marker.strategyRole]),
  [["Long", "entry"], ["REV", "reversal"], ["Short", "entry"]],
  "reversal exits and the new directional entry must be labeled independently"
);

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
assert.equal(nextOpen.strategy?.fills[0].placedIndex, 0, "a delayed fill must retain the signal bar that created the order");
assert.equal(nextOpen.strategy?.fills[0].placedTime, nextOpenCandles[0].time);

const trailingScript = `strategy(default_qty_type=strategy.fixed, default_qty_value=1, process_orders_on_close=True, tick_size=1)
enter = close > open
strategy.entry("Long", strategy.long, when=enter)
strategy.exit("Trail", "Long", trail_points=2, trail_offset=1, when=strategy.position_size > 0)`;
const trailingCandles: Candle[] = [
  { time: 1_835_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_835_000_060, open: 100, high: 104, low: 98, close: 99, volume: 100 }
];
const trailing = compileAndRunScript(trailingScript, trailingCandles);
assert.equal(trailing.success, true, JSON.stringify(trailing.errors));
assert.equal(trailing.strategy?.trades.length, 1, "an activated trailing order must close the matching lot exactly once");
assert.equal(trailing.strategy?.trades[0].exitPrice, 103, "the trailing stop must follow the favorable high before the path reverses");
assert.match(trailing.strategy?.trades[0].exitReason ?? "", /TRAIL$/, "trailing fills must retain their own auditable reason");

const restartCandles: Candle[] = [
  { time: 1_836_000_000, open: 99, high: 101, low: 98, close: 100, volume: 100 },
  { time: 1_836_000_060, open: 101, high: 102, low: 98, close: 99, volume: 100 },
  { time: 1_836_000_120, open: 98, high: 99, low: 96, close: 97, volume: 100 }
];
const uninterrupted = compileAndRunScript(reversalScript, restartCandles);
const beforeRestart = compileAndRunScript(reversalScript, restartCandles.slice(0, 2));
assert.ok(beforeRestart.strategy?.checkpoint, "the engine must expose a durable restart checkpoint");
const afterRestart = compileAndRunScript(reversalScript, restartCandles.slice(1), {}, {
  initialState: beforeRestart.strategy?.checkpoint,
  executionStartIndex: 1
});
assert.deepEqual(
  afterRestart.strategy?.fills.map((fill) => [fill.action, fill.side, fill.price, fill.placedTime]),
  uninterrupted.strategy?.fills.filter((fill) => fill.time >= restartCandles[2].time).map((fill) => [fill.action, fill.side, fill.price, fill.placedTime]),
  "a restarted engine must produce the same next-bar reversal fills as uninterrupted execution"
);
assert.deepEqual(afterRestart.strategy?.openPosition, uninterrupted.strategy?.openPosition, "restart checkpoints must preserve the final virtual position");

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
