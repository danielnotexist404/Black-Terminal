import assert from "node:assert/strict";
import {
  DOM_PANEL_SETTINGS_VERSION,
  applyDomPanelPreset,
  applyDomWorkspacePreset,
  defaultDomPanelRegistry,
  importDomPanelSettings,
  patchDomPanel,
  readDomPanelRegistry,
  resetDomPanel,
  writeDomPanelRegistry
} from "../src/modules/dom-pro/domPanelSettingsStore.ts";
import { placePanelPopover, shouldClosePanelPopover } from "../src/modules/dom-pro/domPanelPopover.ts";
import { DomPanelUpdateScheduler } from "../src/modules/dom-pro/domPanelUpdateScheduler.ts";
import {
  aggregateTradeTape,
  bucketAndSmoothCvd,
  clipAndSmoothSeries,
  MetricsStabilizer,
  PersistentDepthProcessor,
  StableWallProcessor
} from "../src/modules/dom-pro/domSignalStabilizers.ts";
import type { DomMetrics, WallDetection } from "../src/modules/dom-pro/types.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
const defaults = defaultDomPanelRegistry("desk", "bybit:perpetual:BTCUSDT");
assert.equal(Object.keys(defaults.panels).length, 10, "all configurable panels have defaults");
assert.equal(defaults.schemaVersion, DOM_PANEL_SETTINGS_VERSION);

const custom = patchDomPanel(defaults, "depth-chart", { updateIntervalMs: 7123, mode: "macro" });
writeDomPanelRegistry(custom, storage);
const persisted = readDomPanelRegistry("desk", "bybit:perpetual:BTCUSDT", storage);
assert.equal(persisted.panels["depth-chart"].settings.updateIntervalMs, 7123, "panel settings persist");

const migrated = importDomPanelSettings(JSON.stringify({ schemaVersion: 1, panels: { "trade-tape": { settings: { displayRows: 17 } } } }), "desk", "BTC");
assert.equal(migrated.schemaVersion, DOM_PANEL_SETTINGS_VERSION);
assert.equal(migrated.panels["trade-tape"].settings.displayRows, 17);
assert.ok(migrated.panels["wall-detection"], "migration fills missing panels");

const savedDefault = { ...custom, panels: { ...custom.panels, "depth-chart": { ...custom.panels["depth-chart"], defaultSettings: { ...custom.panels["depth-chart"].settings } } } };
const modified = patchDomPanel(savedDefault, "depth-chart", { updateIntervalMs: 100 });
assert.equal(resetDomPanel(modified, "depth-chart").panels["depth-chart"].settings.updateIntervalMs, 7123, "reset restores saved default");

const macro = applyDomWorkspacePreset(defaults, "macro");
assert.equal(macro.panels["depth-chart"].settings.mode, "macro");
assert.equal(macro.panels["wall-detection"].preset, "Major Only");
const override = patchDomPanel(macro, "depth-chart", { updateIntervalMs: 9300 });
assert.equal(override.panels["depth-chart"].settings.updateIntervalMs, 9300, "user override survives preset application");
assert.equal(applyDomPanelPreset(defaults, "heuristic-cvd", "Structural").panels["heuristic-cvd"].settings.horizon, "4h");

const scheduler = new DomPanelUpdateScheduler();
scheduler.registerPanel("trade-tape", 1000, 500);
assert.equal(scheduler.coalesceUpdates("trade-tape", 1000), true);
assert.equal(scheduler.coalesceUpdates("trade-tape", 1200), false, "updates coalesce inside cadence");
scheduler.suspendPanel("trade-tape");
assert.equal(scheduler.shouldCalculate("trade-tape", 5000), false, "hidden panel suspends calculation");
scheduler.resumePanel("trade-tape");
assert.equal(scheduler.shouldCalculate("trade-tape", 5001), true, "resume requests immediate calculation");
scheduler.registerPanel("depth-chart", 1, 1);
assert.equal(scheduler.reportMetrics("depth-chart")[0].calculationMs, 250, "unsafe panel cadence is clamped");

const depth = new PersistentDepthProcessor();
for (let index = 0; index < 12; index += 1) {
  depth.ingest([{ price: 99, quantity: 10 + index % 2 }, { price: 98, quantity: 5 }], [{ price: 101, quantity: 8 }, { price: 102, quantity: 4 }], 20);
}
depth.ingest([{ price: 97, quantity: 100 }], [], 20);
const structuralBids = depth.structural("bid", 50, 1);
assert.ok(structuralBids.some((level) => level.price === 99), "persistent depth survives structural filter");
assert.ok(!structuralBids.some((level) => level.price === 97), "single-snapshot depth is filtered");
assert.ok(structuralBids.find((level) => level.price === 99)!.quantity < structuralBids.find((level) => level.price === 99)!.averageSize, "structural quantity includes persistence weighting");

const wallBase: WallDetection = { id: "buy:99", side: "buy", price: 99, size: 20, score: 70, distancePct: 1, persistenceMs: 10_000, persistencePct: 90, state: "persisting" };
const wallProcessor = new StableWallProcessor();
assert.equal(wallProcessor.update([wallBase], wallOptions(2), 10_000).length, 0, "minimum wall observation count is enforced");
assert.equal(wallProcessor.update([wallBase], wallOptions(2), 11_000).length, 1);
const hysteresisWall = { ...wallBase, score: 50, size: 18 };
assert.equal(wallProcessor.update([hysteresisWall], wallOptions(2), 12_000).length, 1, "wall remains active above deactivation threshold");
const pulled = wallProcessor.update([], wallOptions(2), 13_000);
assert.equal((pulled[0] as WallDetection & { lifecycle: string }).lifecycle, "pulled", "wall lifecycle preserves pulled wall");

const cvd = bucketAndSmoothCvd([{ time: 0, value: 0 }, { time: 3, value: 10 }, { time: 11, value: 20 }, { time: 19, value: 30 }], 10, 4, 2);
assert.equal(cvd.length, 2, "CVD aggregates into stable time buckets");
assert.ok(cvd[1].value < 30, "CVD smoothing limits raw movement");

const metricRaw: DomMetrics = { orderBookImbalance: 50, depthImbalance: 40, liquidityScore: 80, largeTradesLastMinute: 4, bidStacked: 100, askStacked: 20, bidPulled: 1, askPulled: 1, updateRate: 30, latencyMs: 20 };
const metrics = new MetricsStabilizer();
assert.equal(metrics.update(metricRaw, 10, 5, 1000, 0).liquidityState, "BALANCED");
assert.equal(metrics.update(metricRaw, 10, 5, 1000, 1500).liquidityState, "STACKING", "metric state waits for confirmation duration");
assert.ok(metrics.update({ ...metricRaw, orderBookImbalance: -50 }, 10, 5, 1000, 1600).orderBookImbalance > -50, "metrics use EMA smoothing");

const tape = aggregateTradeTape([
  { tradeId: "a", time: 1000, price: 100, quantity: 1, side: "buy" },
  { tradeId: "b", time: 1000.2, price: 100, quantity: 2, side: "buy" },
  { tradeId: "c", time: 1000.4, price: 101, quantity: 0.01, side: "sell" }
], { minimumTradeSize: 0.1, groupingIntervalMs: 1000, aggregateSamePrice: true, displayRows: 10 });
assert.equal(tape.length, 1);
assert.equal(tape[0].quantity, 3, "same-price tape prints aggregate");

const flow = clipAndSmoothSeries([{ net: 1 }, { net: 2 }, { net: 1000 }, { net: 2 }], 75, 3);
assert.ok(Math.max(...flow.map((point) => Math.abs(point.net))) < 1000, "flow outliers are clipped");

const placement = placePanelPopover({ left: 990, bottom: 790, width: 20 }, { width: 1000, height: 800 });
assert.ok(placement.left >= 10 && placement.top >= 10, "popover stays inside viewport");
assert.equal(shouldClosePanelPopover("escape"), true);
assert.equal(shouldClosePanelPopover("outside"), true);
assert.equal(shouldClosePanelPopover("inside"), false);
assert.equal(shouldClosePanelPopover("anchor"), false);

console.log("DOM Pro panel settings and stabilization tests passed.");

function wallOptions(minimumObservations: number) {
  return { activationScore: 60, deactivationScore: 40, minimumPersistenceMs: 5000, minimumObservations, maximumRows: 8, sortMode: "reliability", majorOnly: false };
}
