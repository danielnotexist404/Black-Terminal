import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildExecutionDeskActions,
  buildExecutionDeskMetrics,
  confirmedStrategyCandles,
  executionDeskData,
  executionMarkers,
  strategySignalMarkers,
  superAtrHistoricalStrategyMarkers,
} from "../src/modules/strategy-lab/execution-desk/executionDeskModel.ts";
import { applyStrategyControlPanel, readStrategyControlPanel, superAtrTakeProfitAllocation } from "../src/modules/strategy-lab/execution-desk/strategyControlPanelModel.ts";
import { paperStrategyDestinationKey, preferredStrategyDestination, resolveStrategyDestination, selectableStrategyBindings } from "../src/modules/strategy-lab/execution-desk/strategyDestinationModel.ts";
import { createSuperAtrSevenStepSignals, positionAwareStrategyEntries, superAtrTakeProfitPlan } from "../src/modules/strategy-lab/adapters/signalAdapter.ts";
import { compileAndRunScript } from "../src/components/ScriptCompiler.ts";

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
const confirmedBeforeAppend = confirmedStrategyCandles(signalCandles.slice(0, 3), 300, 10_000);
assert.deepEqual(confirmedBeforeAppend.map((candle) => candle.time), [1_000, 1_300], "the newest REST candle remains provisional even when the browser clock is ahead");
const confirmedAfterAppend = confirmedStrategyCandles(signalCandles, 300, 10_000);
assert.deepEqual(confirmedAfterAppend.map((candle) => candle.time), [1_000, 1_300, 1_600], "a candle becomes immutable only after its successor is present");
assert.deepEqual(confirmedAfterAppend.slice(0, confirmedBeforeAppend.length), confirmedBeforeAppend, "confirmed strategy history is append-only across feed refreshes");
const historicalMarkers = strategySignalMarkers([
  { timestamp: 1_000, symbol: "BTCUSDT", direction: "long", entry: true },
  { timestamp: 1_300, symbol: "BTCUSDT", direction: "long", entry: true },
  { timestamp: 1_600, symbol: "BTCUSDT", direction: "short", entry: true },
  { timestamp: 1_900, symbol: "BTCUSDT", direction: "long", entry: true },
], signalCandles, 300);
assert.deepEqual(historicalMarkers.map((item) => item.label), ["LONG ENTRY", "CLOSE POSITION LONG", "SHORT ENTRY", "CLOSE POSITION SHORT", "LONG ENTRY"], "historical markers follow position-aware TradingView entries and reversals");
assert.equal(historicalMarkers[0]?.signalPrice, 101, "historical signals anchor to the confirmed candle close");
const nextTickMarkers = strategySignalMarkers([
  { timestamp: 1_000, symbol: "BTCUSDT", direction: "long", entry: true },
  { timestamp: 1_600, symbol: "BTCUSDT", direction: "long", entry: true },
], signalCandles, 300, { pyramiding: 1, processOrdersOnClose: false });
assert.deepEqual(nextTickMarkers.map((item) => item.label), ["LONG ENTRY"], "a separated repeat in the already-open direction is not a second trade");
assert.equal(nextTickMarkers[0]?.time, 1_300, "the default Pine one-tick delay fills at the following bar");
assert.equal(nextTickMarkers[0]?.signalPrice, 101, "a delayed historical market entry uses the following bar open");

const takeProfitCandles = [
  { time: 1_000, open: 99, high: 101, low: 98, close: 100, volume: 10 },
  { time: 1_300, open: 100, high: 102, low: 98, close: 100, volume: 10 },
  { time: 1_600, open: 100, high: 111, low: 99, close: 105, volume: 10 },
  { time: 1_900, open: 105, high: 115, low: 104, close: 110, volume: 10 },
];
const projectedTakeProfits = superAtrHistoricalStrategyMarkers([
  { timestamp: 1_000, symbol: "BTCUSDT", direction: "long", entry: true },
], takeProfitCandles, takeProfitCandles, 300, {
  superAtrMultiStepTakeProfit: true,
  superAtrTakeProfitAtrLength: 1,
  superAtrAtrMultipliers: [1, 2, 3, 4],
  superAtrFixedPercentages: [10, 20, 30],
  superAtrAtrExitPercent: 10,
  superAtrFixedExitPercent: 10,
}, { pyramiding: 1, processOrdersOnClose: false });
assert.deepEqual(
  projectedTakeProfits.filter((marker) => marker.strategyRole === "takeProfit").map((marker) => `${marker.label}:${marker.time}`),
  ["TP1:1600", "TP2:1600", "TP5:1600"],
  "the chart replays next-bar eligible ATR and fixed partial exits without look-ahead",
);
assert.equal(projectedTakeProfits.find((marker) => marker.label === "TP1")?.signalPrice, 104, "a touched limit fills at its limit price");
assert.equal(projectedTakeProfits.filter((marker) => marker.label === "TP1").length, 1, "one Pine strategy.exit ID fills only once per position");

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
const targetBinding = (overrides: Record<string, unknown> = {}) => ({
  id: "mainnet-binding",
  strategyId: "strategy",
  strategyVersion: 1,
  slotIndex: 2,
  targetType: "BROKER_ACCOUNT" as const,
  targetId: "mainnet-account",
  targetLabel: "Bybit Mainnet",
  marketType: "FUTURES" as const,
  status: "LIVE" as const,
  capitalPolicyVersion: 1,
  capitalPolicy: policy,
  validation: { eligible: true },
  rowVersion: 1,
  createdAt: "2026-08-30T00:00:00Z",
  updatedAt: "2026-08-30T00:00:00Z",
  ...overrides,
});
const liveBinding = targetBinding();
const disconnectedBinding = targetBinding({ id: "old-binding", targetId: "old-account", status: "DISCONNECTED" as const });
assert.equal(
  preferredStrategyDestination([disconnectedBinding, liveBinding], { targetType: "PAPER", authorizationAccepted: false, armOnActivation: false }),
  liveBinding.id,
  "attaching a live broker after Paper setup automatically makes it the settings destination",
);
assert.deepEqual(selectableStrategyBindings([disconnectedBinding, liveBinding]).map((binding) => binding.id), [liveBinding.id], "disconnected audit rows never become settings destinations");
assert.equal(resolveStrategyDestination(liveBinding.id, [liveBinding]).mode, "AUTHORITATIVE", "a selected broker always enters authoritative-equity mode");
assert.equal(resolveStrategyDestination(paperStrategyDestinationKey, [liveBinding]).mode, "PAPER", "only an explicit Paper selection displays initial capital");
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
const migratedLegacyPanel = readStrategyControlPanel({
  ...baseDefinition,
  settings: {
    superAtrShortPeriod: 3,
    superAtrLongPeriod: 7,
    superAtrMomentumPeriod: 7,
    superAtrConfirmationPeriod: 7,
    superAtrTrendStrengthThreshold: 1.618,
    superAtrMultiStepTakeProfit: true,
    superAtrTakeProfitAtrLength: 14,
    superAtrAtrMultipliers: [2.618, 5, 10, 13.82],
    superAtrFixedPercentages: [3, 8, 17],
    superAtrAtrExitPercent: 10,
    superAtrFixedExitPercent: 10,
  },
}, policy, 5_000);
assert.deepEqual(migratedLegacyPanel.inputs, {
  shortPeriod: 30,
  longPeriod: 70,
  momentumPeriod: 7,
  atrConfirmationPeriod: 7,
  trendStrengthThreshold: 3.1,
  multiStepTakeProfit: true,
  takeProfitAtrLength: 100,
  atrMultipliers: [100, 70, 120, 300],
  fixedTakeProfitPercentages: [21, 21, 75],
  atrExitPercent: 10,
  fixedExitPercent: 10,
}, "the exact legacy seed upgrades to the user's tuned SuperATR preset");
const largeValuePanel = readStrategyControlPanel({
  ...baseDefinition,
  settings: {
    "Short Period": 30_000,
    "Long Period": 70_000,
    "ATR Multiplier for TP Level 1": 200_000,
    "Fixed TP Level 3 (%)": 175_000,
  },
}, policy, 5_000);
assert.equal(largeValuePanel.inputs.shortPeriod, 30_000, "Strategy Lab does not invent a period ceiling");
assert.equal(largeValuePanel.inputs.longPeriod, 70_000);
assert.equal(largeValuePanel.inputs.atrMultipliers[0], 200_000, "Strategy Lab does not invent a take-profit multiplier ceiling");
assert.equal(largeValuePanel.inputs.fixedTakeProfitPercentages[2], 175_000);
const panel = readStrategyControlPanel(baseDefinition, policy, 5_000);
panel.properties = { ...panel.properties, orderSizeMode: "PERCENT_EQUITY", orderSizeValue: 35, longLeverage: 25, shortLeverage: 15 };
panel.inputs = { ...panel.inputs, shortPeriod: 3, longPeriod: 8, trendStrengthThreshold: 0.05, takeProfitAtrLength: 14, atrMultipliers: [2.618, 5, 10, 13.82], fixedTakeProfitPercentages: [3, 8, 17], atrExitPercent: 10, fixedExitPercent: 10 };
const configured = applyStrategyControlPanel(baseDefinition, policy, panel);
assert.equal(configured.capitalPolicy.tradeAmountMode, "PERCENT_ACCOUNT_EQUITY");
assert.equal(configured.capitalPolicy.tradeAmountValue, 35);
assert.equal(configured.capitalPolicy.requestedLongLeverage, 25);
assert.equal(configured.capitalPolicy.requestedShortLeverage, 15);
assert.equal(configured.definition.execution.longLeverage, 25);
const targetSpecificPanel = readStrategyControlPanel(
  { ...baseDefinition, controlPanel: panel },
  { ...policy, tradeAmountValue: 20, requestedLongLeverage: 5, requestedShortLeverage: 3 },
  189_696.35,
  true,
);
assert.equal(targetSpecificPanel.properties.initialCapital, 189_696.35, "the selected broker snapshot supplies full account equity");
assert.equal(targetSpecificPanel.properties.orderSizeValue, 20, "destination sizing overrides stale definition properties");
assert.equal(targetSpecificPanel.properties.longLeverage, 5, "destination long leverage overrides stale definition properties");
assert.equal(targetSpecificPanel.properties.shortLeverage, 3, "destination short leverage overrides stale definition properties");
assert.deepEqual(superAtrTakeProfitAllocation(panel), [10, 10, 10, 10, 10, 10, 10]);
const trendingCandles = Array.from({ length: 180 }, (_, index) => {
  const close = 20_000 + index * 40 + index * index * 0.15;
  return { time: 1_700_000_000 + index * 14_400, open: close - 30, high: close + 70 + index * .4, low: close - 60, close, volume: 1_000 + index * 5 };
});
const superAtrSignals = createSuperAtrSevenStepSignals(trendingCandles, "BTCUSDT", configured.definition.settings);
assert.ok(superAtrSignals.length > 0, "the native SuperATR adapter produces confirmed trend entries");
assert.equal(superAtrSignals.at(-1)?.takeProfits?.length, 7, "the adapter emits all seven independently sized exits");
assert.ok(superAtrSignals.at(-1)?.takeProfits?.every((target) => Number.isFinite(target.price) && target.price > 0), "take-profit plan contains finite venue prices");

const parityCandles = Array.from({ length: 1_200 }, (_, index) => {
  const cycle = Math.sin(index / 27) * 900 + Math.sin(index / 7) * 120;
  const drift = Math.floor(index / 180) % 2 === 0 ? index % 180 * 7 : (180 - index % 180) * 7;
  const close = 30_000 + cycle + drift;
  const prior = index ? 30_000 + Math.sin((index - 1) / 27) * 900 + Math.sin((index - 1) / 7) * 120 : close;
  return { time: 1_720_000_000 + index * 300, open: prior, high: Math.max(prior, close) + 80, low: Math.min(prior, close) - 80, close, volume: 1_000 + index };
});
const paritySettings = {
  ...baseDefinition.settings,
  superAtrShortPeriod: 3,
  superAtrLongPeriod: 7,
  superAtrMomentumPeriod: 7,
  superAtrConfirmationPeriod: 7,
  superAtrTrendStrengthThreshold: 1.618,
  superAtrMultiStepTakeProfit: true,
  superAtrTakeProfitAtrLength: 14,
  superAtrAtrMultipliers: [2.618, 5, 10, 13.82],
  superAtrFixedPercentages: [3, 8, 17],
  superAtrAtrExitPercent: 10,
  superAtrFixedExitPercent: 10,
};
const nativeParityEntries = positionAwareStrategyEntries(createSuperAtrSevenStepSignals(parityCandles, "BTCUSDT", paritySettings), 1)
  .map((signal) => signal.timestamp + 300);
const paritySource = fs.readFileSync(new URL("./examples/superatr-seven-step-black-terminal.py", import.meta.url), "utf8");
const compiledParity = compileAndRunScript(paritySource, parityCandles);
assert.equal(compiledParity.success, true, JSON.stringify(compiledParity.errors));
const scriptParityEntries = compiledParity.strategy?.fills.filter((fill) => fill.action === "entry").map((fill) => fill.time) || [];
assert.deepEqual(nativeParityEntries, scriptParityEntries, "the certified VPS adapter and the saved SuperATR script must produce identical next-open entries candle by candle");
const firstPlan = superAtrTakeProfitPlan(parityCandles.slice(0, 600), "long", 30_000, paritySettings);
const expandedPlan = superAtrTakeProfitPlan([
  ...parityCandles.slice(0, 600),
  { ...parityCandles[600]!, high: parityCandles[600]!.high + 5_000, low: parityCandles[600]!.low - 5_000 },
], "long", 30_000, paritySettings);
assert.equal(firstPlan.length, 7);
assert.notEqual(firstPlan[0]?.price, expandedPlan[0]?.price, "ATR take-profit orders must be repriced from the latest completed candle like repeated Pine strategy.exit calls");
assert.equal(firstPlan[4]?.price, expandedPlan[4]?.price, "fixed-percentage take-profit levels stay anchored to the actual entry average");

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
assert.match(deskSource, /preferredStrategyDestination\(connectedBindings, workspace\.strategy\.definition\.deployment\)/, "a configured broker or group is selected instead of silently defaulting to Paper");
assert.match(deskSource, /manuallySelectedSource\.current = true/, "an explicit Paper selection remains available after a live destination is attached");
assert.match(deskSource, /historicalSignalMarkers\(strategy\.definition, calculationCandles, candles\)/, "the dedicated chart calculates position-aware signals from hidden seed history before the first broker fill");
assert.match(deskSource, /to: oldest - 1/, "the dedicated chart paginates authoritative candles behind the visible window instead of starting flat at the viewport edge");
assert.match(deskSource, /const visibleBarCount = 9_000/, "the dedicated chart exposes the maximum safe paginated history while retaining a hidden state seed");
for (const label of ["INPUTS", "PROPERTIES", "STYLE", "VISIBILITY", "Default order size", "Long entry leverage · per trade", "Short entry leverage · per trade", "Percentage to Exit at Each ATR TP Level"]) assert.match(settingsSource, new RegExp(label, "i"));
assert.match(settingsSource, /Full account equity · API/, "connected-account equity is identified as authoritative broker data");
assert.match(settingsSource, /if \(!dirty\.current\)/, "workspace refreshes cannot overwrite unsaved numeric edits");
assert.match(settingsSource, /setValue\(structuredClone\(submitted\)\)/, "a successful save retains the submitted form instead of restoring its stale pre-save snapshot");
assert.match(settingsSource, /cannot exceed the broker's current available funds/, "fixed-USDT sizing is bounded by authoritative broker funds in the settings surface");
assert.match(cockpitSource, /SETTINGS DESTINATION/, "the settings tab explicitly selects Paper or one of the connected destinations");
assert.match(cockpitSource, /snapshot\?\.equity/, "the selected destination's API equity is supplied to the settings panel");
assert.match(cockpitSource, /snapshot\?\.availableBalance/, "the selected destination's current available funds constrain fixed-USDT sizing");
assert.match(settingsSource, /authoritativeDestination \? displayedEquity \?\? "" : item\.initialCapital/, "a connected broker never falls back to the script's 10,000 initial-capital seed while equity is unavailable");
assert.match(settingsSource, /LAST-KNOWN BROKER EQUITY/, "degraded broker equity remains visibly diagnostic while live sizing stays locked");
assert.match(settingsSource, /BROKER EQUITY IS SYNCHRONIZING/, "missing broker equity is reported as synchronization state instead of a fictional balance");
assert.match(settingsSource, /authoritativeFreshness === "LIVE"/, "only a live authoritative broker snapshot unlocks equity sizing");
assert.match(settingsSource, /authoritativeFreshness !== "LIVE"/, "saving remains fail-closed when the broker snapshot is stale or degraded");
assert.match(settingsSource, /Refresh or restore broker reconciliation before saving live sizing/, "live sizing remains fail-closed until positive broker equity is authoritative");
assert.match(serviceSource, /clean\[0\] === "group-execution-desks"/);
assert.match(repositorySource, /Join this Investment Group before opening its Strategy Execution Desk/);
assert.doesNotMatch(repositorySource, /row\.running_version\s*\?\?[\s\S]{0,100}row\.current_version/, "published versions never masquerade as explicitly started runtime versions");
assert.match(workerSource, /Number\(strategy\.running_version \?\? 0\)/, "the VPS worker leases only an explicitly started version");
assert.match(workerSource, /const venueTimestamp = Number\(payload\.time\)/, "Bybit server time, not VPS clock drift, certifies a candle boundary");
assert.match(workerSource, /positionAwareStrategyEntries\([\s\S]*signals,[\s\S]*pyramiding/, "the VPS accepts only Pine position transitions, never a repeated same-direction setup on a newly armed account");
assert.match(workerSource, /candidateSignal\.direction !== persistedDirection/, "persisted Pine direction survives rolling candle windows and suppresses restart duplicates");
assert.match(deskSource, /adaptiveSwingStrategy: false/, "the dedicated chart never starts a second intrabar signal engine beside its certified markers");
assert.match(repositorySource, /STRATEGY_TRADE_AMOUNT_EXCEEDS_AVAILABLE_FUNDS/, "the server rejects a fixed order amount above synchronized broker funds");
assert.match(workerSource, /nextTickReference/, "paper reversals use the next available tick rather than the already-closed signal price");
assert.match(workerSource, /refreshPaperTakeProfitPlan/, "the paper runtime updates Pine-style dynamic ATR targets after each completed candle");
assert.match(repositorySource, /definition:\s*\{[\s\S]*settings: \{\},[\s\S]*execution: \{\}/);
assert.match(adapterSource, /pineStdev\(closes, momentumPeriod\)/, "SuperATR normalizes momentum with the Pine close-series deviation");
assert.match(adapterSource, /pineSma\(atrMultiple, momentumPeriod\)/, "SuperATR trend strength uses the Pine momentum-period average without partial windows");
assert.match(adapterSource, /takeProfitAtr = pineAtr\(candles, takeProfitAtrLength\)/, "SuperATR exits use Pine-compatible Wilder ATR rather than the signal ATR SMA");

console.log("Strategy Execution Desk model tests passed.");
