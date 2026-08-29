import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildExecutionDeskActions,
  buildExecutionDeskMetrics,
  executionDeskData,
  executionMarkers,
  strategySignalMarkers,
} from "../src/modules/strategy-lab/execution-desk/executionDeskModel.ts";
import { applyStrategyControlPanel, readStrategyControlPanel, superAtrTakeProfitAllocation } from "../src/modules/strategy-lab/execution-desk/strategyControlPanelModel.ts";
import { createSuperAtrSevenStepSignals } from "../src/modules/strategy-lab/adapters/signalAdapter.ts";

const data = executionDeskData({
  positions: [{ id: "open", unrealized_pnl: 125 }],
  orders: [{ id: "working", status: "WORKING" }],
  executions: [
    { id: "entry-live", side: "BUY", price: 100, quantity: 2, executed_at: "2026-08-28T10:00:00Z", signal_key: "confirmed-long" },
    { id: "tp-seven", side: "SELL", price: 121, quantity: .2, executed_at: "2026-08-28T12:00:00Z", signal_key: "swing:TP7" },
  ],
  trades: [
    { id: "closed-long", side: "LONG", quantity: 2, entry_price: 100, exit_price: 110, net_pnl: 20, opened_at: "2026-08-28T10:00:00Z", closed_at: "2026-08-28T11:00:00Z", exit_reason: "OPPOSITE_SIGNAL" },
    { id: "closed-short", side: "SHORT", quantity: 1, entry_price: 110, exit_price: 105, net_pnl: -5, opened_at: "2026-08-28T11:00:00Z", closed_at: "2026-08-28T12:30:00Z", exit_reason: "TAKE_PROFIT_3" },
  ],
  analytics: { netPnl: 15, winRate: 50, profitFactor: 4, maximumDrawdownPercent: 2.5, currentDrawdownPercent: 1 },
});

const actions = buildExecutionDeskActions(data, "LIVE");
assert.ok(actions.some((action) => action.action === "LONG" && action.role === "entry"));
assert.ok(actions.some((action) => action.action === "SHORT" && action.role === "entry"));
assert.ok(actions.some((action) => action.action === "TP7" && action.role === "takeProfit"));
assert.ok(actions.some((action) => action.action === "TP3" && action.role === "takeProfit"));
assert.ok(actions.some((action) => action.action === "CLOSE POSITION LONG" && action.role === "reversal"));

const metrics = buildExecutionDeskMetrics(data, null, {
  bindingId: "binding",
  slotIndex: 1,
  timestamp: Date.now(),
  freshness: "LIVE",
  equity: 10_140,
  availableBalance: 9_000,
  allocatedStrategyCapital: 10_000,
  usedStrategyCapital: 1_000,
  freeStrategyCapital: 9_000,
  openPositions: 1,
  openOrders: 1,
  realizedPnl: 15,
  unrealizedPnl: 125,
  grossPnl: 140,
  fees: 2,
  funding: 1,
  netPnl: 137,
  currentDrawdownPercent: 1,
  maximumDrawdownPercent: 2.5,
  winRate: 50,
  profitFactor: 4,
  tradeCount: 2,
  strategyState: "LIVE",
  connectionHealth: "LIVE",
  protectionHealth: "PROTECTED",
});
assert.equal(metrics.ongoingPnl, 137);
assert.equal(metrics.profitFactor, 4);
assert.equal(metrics.openPositions, 1);

const marker = executionMarkers(actions.filter((action) => action.action === "TP7"), [1_777_374_000, 1_777_377_600, 1_777_381_200])[0];
assert.equal(marker?.label, "TP7");
assert.equal(marker?.strategyRole, "takeProfit");

const signalCandles = [
  { time: 1_000, open: 99, high: 102, low: 98, close: 101, volume: 10 },
  { time: 1_300, open: 101, high: 103, low: 100, close: 102, volume: 10 },
  { time: 1_600, open: 102, high: 103, low: 99, close: 100, volume: 10 },
  { time: 1_900, open: 100, high: 104, low: 99, close: 103, volume: 10 },
];
const historicalMarkers = strategySignalMarkers([
  { timestamp: 1_000, symbol: "BTCUSDT", direction: "long", entry: true },
  { timestamp: 1_300, symbol: "BTCUSDT", direction: "long", entry: true },
  { timestamp: 1_600, symbol: "BTCUSDT", direction: "short", entry: true },
  { timestamp: 1_900, symbol: "BTCUSDT", direction: "long", entry: true },
], signalCandles, 300);
assert.deepEqual(historicalMarkers.map((item) => item.label), ["LONG SIGNAL", "SHORT SIGNAL", "LONG SIGNAL"], "consecutive same-state bars collapse into one confirmed historical signal marker");
assert.equal(historicalMarkers[0]?.signalPrice, 101, "historical signals anchor to the confirmed candle close");

const baseDefinition = {
  runtimeKind: "builtin-superatr-seven-step" as const,
  symbol: "BTCUSDT",
  timeframe: "4h",
  marketType: "FUTURES" as const,
  exchange: "bybit",
  settings: { emaFastLength: 20, emaSlowLength: 50, stopLossPercent: 1, takeProfitRatio: 2 },
  execution: {},
};
const policy = {
  strategyAllocationMode: "PERCENT_ACCOUNT_EQUITY" as const,
  strategyAllocationValue: 100,
  tradeAmountMode: "PERCENT_STRATEGY_ALLOCATION" as const,
  tradeAmountValue: 10,
  requestedLeverage: 1,
  maximumLeverage: 50,
  maximumPositionPercent: 100,
  maximumExposurePercent: 100,
  maximumDailyLoss: 500,
  maximumDrawdown: 20,
  maximumPositions: 1,
  slippageBps: 5,
  marginMode: "CROSS" as const,
};
const labelledPanel = readStrategyControlPanel({
  ...baseDefinition,
  settings: {
    ...baseDefinition.settings,
    "Short Period": 30,
    "Long Period": 70,
    "Momentum Period": 9,
    "Trend Strength Threshold": 3.1,
    "ATR Multiplier for TP Level 1": 100,
    "Fixed TP Level 3 (%)": 75,
  },
}, policy, 5_000);
assert.equal(labelledPanel.inputs.shortPeriod, 30, "saved Script Editor labels hydrate native SuperATR inputs");
assert.equal(labelledPanel.inputs.longPeriod, 70);
assert.equal(labelledPanel.inputs.momentumPeriod, 9);
assert.equal(labelledPanel.inputs.trendStrengthThreshold, 3.1);
assert.equal(labelledPanel.inputs.atrMultipliers[0], 100);
assert.equal(labelledPanel.inputs.fixedTakeProfitPercentages[2], 75);
const panel = readStrategyControlPanel(baseDefinition, policy, 5_000);
panel.properties = { ...panel.properties, orderSizeMode: "PERCENT_EQUITY", orderSizeValue: 35, longLeverage: 25, shortLeverage: 15 };
panel.inputs = { ...panel.inputs, shortPeriod: 3, longPeriod: 8, trendStrengthThreshold: 0.05, atrExitPercent: 10, fixedExitPercent: 10 };
const configured = applyStrategyControlPanel(baseDefinition, policy, panel);
assert.equal(configured.capitalPolicy.tradeAmountMode, "PERCENT_ACCOUNT_EQUITY");
assert.equal(configured.capitalPolicy.tradeAmountValue, 35);
assert.equal(configured.definition.execution.longLeverage, 25);
assert.deepEqual(superAtrTakeProfitAllocation(panel), [10, 10, 10, 10, 10, 10, 10]);
const trendingCandles = Array.from({ length: 180 }, (_, index) => {
  const close = 20_000 + index * 40 + index * index * 0.15;
  return { time: 1_700_000_000 + index * 14_400, open: close - 30, high: close + 70 + index * .4, low: close - 60, close, volume: 1_000 + index * 5 };
});
const superAtrSignals = createSuperAtrSevenStepSignals(trendingCandles, "BTCUSDT", configured.definition.settings);
assert.ok(superAtrSignals.length > 0, "the native SuperATR adapter produces confirmed trend entries");
assert.equal(superAtrSignals.at(-1)?.takeProfits?.length, 7, "the adapter emits all seven independently sized exits");
assert.ok(superAtrSignals.at(-1)?.takeProfits?.every((target) => Number.isFinite(target.price) && target.price > 0), "take-profit plan contains finite venue prices");

const cockpitSource = fs.readFileSync(new URL("../src/modules/strategy-lab/my-strategy/pages/StrategyCockpitPage.tsx", import.meta.url), "utf8");
const deskSource = fs.readFileSync(new URL("../src/modules/strategy-lab/execution-desk/StrategyExecutionDesk.tsx", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../src/modules/strategy-lab/execution-desk/StrategyControlPanelDialog.tsx", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../server/strategy-automation/service.js", import.meta.url), "utf8");
const repositorySource = fs.readFileSync(new URL("../server/strategy-automation/repository.js", import.meta.url), "utf8");
const adapterSource = fs.readFileSync(new URL("../src/modules/strategy-lab/adapters/signalAdapter.ts", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../scripts/strategy-automation-worker.ts", import.meta.url), "utf8");
assert.match(cockpitSource, /\["executionDesk", "EXECUTION DESK"\]/);
assert.match(deskSource, /This chart is owned by the strategy runtime\. It never mounts the strategy onto the default discretionary chart\./);
assert.doesNotMatch(deskSource, /onDefinitionChange|onVisibleIndicatorsChange|setActiveNav/);
assert.match(deskSource, /preferredExecutionSource\(workspace\)/, "a configured broker or group is selected instead of silently defaulting to Paper");
assert.match(deskSource, /historicalSignalMarkers\(strategy\.definition, candles\)/, "the dedicated chart renders confirmed historical strategy signals before the first broker fill");
for (const label of ["INPUTS", "PROPERTIES", "STYLE", "VISIBILITY", "Default order size", "Long leverage", "Short leverage", "Percentage to Exit at Each ATR TP Level"]) assert.match(settingsSource, new RegExp(label, "i"));
assert.match(serviceSource, /clean\[0\] === "group-execution-desks"/);
assert.match(repositorySource, /Join this Investment Group before opening its Strategy Execution Desk/);
assert.doesNotMatch(repositorySource, /row\.running_version\s*\?\?[\s\S]{0,100}row\.current_version/, "published versions never masquerade as explicitly started runtime versions");
assert.match(workerSource, /Number\(strategy\.running_version \?\? 0\)/, "the VPS worker leases only an explicitly started version");
assert.match(repositorySource, /definition:\s*\{[\s\S]*settings: \{\},[\s\S]*execution: \{\}/);
assert.match(adapterSource, /rollingStdev\(closes, momentumPeriod\)/, "SuperATR normalizes momentum with the Pine close-series deviation");
assert.match(adapterSource, /sma\(atrMultiple, momentumPeriod\)/, "SuperATR trend strength uses the Pine momentum-period average");
assert.match(adapterSource, /takeProfitAtr = atr\(candles, takeProfitAtrLength\)/, "SuperATR exits use Pine-compatible Wilder ATR rather than the signal ATR SMA");

console.log("Strategy Execution Desk model tests passed.");
