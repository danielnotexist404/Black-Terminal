import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import {
  applyDomProLayoutPreset,
  createDomProLayout,
  domLeafWeights,
  domSeparatorPositions,
  listDomProLayoutPresets,
  maximizeDomPanel,
  patchDomPanelLayout,
  readDomProLayout,
  readDomProLayoutPreset,
  resizeDomSplit,
  saveDomProLayoutPreset,
  splitSpanRatio,
  writeDomProLayout
} from "../src/modules/dom-pro/domWorkspaceLayout.ts";
import { availableDomOrderTypes, availableDomTimeInForce, DOM_EQUITY_ALLOCATION_MARKERS, domExecutionLayoutMode, nearestLeverageOptions } from "../src/modules/dom-pro/domExecutionPresentation.ts";
import type { VenueExecutionSchema } from "../src/execution/venueExecutionSchema.ts";
import { computeDomWallLabelLayout } from "../src/modules/dom-pro/domWallLabelLayout.ts";
import { buildDomLadderModel } from "../src/modules/dom-pro/domLadderModel.ts";
import type { AggregatedDomSnapshot } from "../src/modules/dom-pro/types.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
const layout = createDomProLayout("desk");
assert.equal(layout.rootSplit.ratio, 0.70, "factory layout reserves a compact 30 percent bottom row");
assert.ok(Math.abs(domLeafWeights(layout.upperSplit).reduce((sum, leaf) => sum + leaf.weight, 0) - 1) < 1e-9, "upper split weights remain normalized");
assert.equal(domSeparatorPositions(layout.upperSplit).length, 5, "every upper panel boundary has a separator");
assert.equal(domSeparatorPositions(layout.bottomSplit).length, 2, "every bottom panel boundary has a separator");
assert.ok(splitSpanRatio(layout.upperSplit, "upper-volume-profile") < 1, "nested split reports its allocated viewport span");
const resized = resizeDomSplit(layout, "root", "workspace-upper-bottom", -0.1);
assert.equal(resized.rootSplit.ratio, 0.60, "horizontal resize changes only workspace geometry");
assert.equal(resizeDomSplit(layout, "root", "workspace-upper-bottom", -10).rootSplit.ratio, 0.56, "minimum row constraint is enforced");
assert.equal(resizeDomSplit(layout, "root", "workspace-upper-bottom", 10).rootSplit.ratio, 0.86, "maximum row constraint is enforced");
const collapsedLayout = patchDomPanelLayout(layout, "execution", { collapsed: true });
assert.equal(collapsedLayout.panelStates.execution.collapsed, true, "panel collapse is represented in layout state");
assert.equal(maximizeDomPanel(layout, "liquidity-heatmap").maximizedPanel, "liquidity-heatmap", "panel maximize preserves underlying layout");
assert.ok(applyDomProLayoutPreset(layout, "analysis-focus").rootSplit.ratio > layout.rootSplit.ratio, "analysis preset expands the upper workspace");
assert.deepEqual(availableDomTimeInForce(null, "limit", false), ["gtc", "ioc", "fok"]);
assert.deepEqual(availableDomTimeInForce(null, "market", false), [], "market orders use venue-default TIF");
assert.deepEqual(availableDomTimeInForce(null, "limit", true), ["gtc"], "post-only rejects incompatible TIF modes");
const executionSchema = {
  supportedOrderModes: [
    { orderTypes: ["market"] },
    { orderTypes: ["limit"] },
    { orderTypes: ["stop-market", "stop-limit"] },
    { orderTypes: ["chase-limit"] },
    { orderTypes: ["twap"] },
    { orderTypes: ["iceberg"] },
    { orderTypes: ["pov"] }
  ]
} as VenueExecutionSchema;
assert.deepEqual(availableDomOrderTypes(executionSchema), ["market", "limit", "stop-market", "stop-limit", "chase-limit", "twap", "iceberg", "pov"], "DOM execution exposes every venue-certified order type");
assert.ok(nearestLeverageOptions(1, 20, 1, 17).includes(17), "current venue leverage remains selectable");
assert.deepEqual(DOM_EQUITY_ALLOCATION_MARKERS, [0, 1, 5, 10, 15, 25, 35, 50, 65, 75, 100]);
assert.equal(domExecutionLayoutMode(280), "minimal");
assert.equal(domExecutionLayoutMode(760), "wide");
const wallLabel = computeDomWallLabelLayout({ top: 20, height: 16, width: 300, measuredWidth: 92 });
assert.equal(wallLabel.y, 28, "wall label is vertically centered inside its strip");
assert.ok(wallLabel.y >= wallLabel.clipY && wallLabel.y <= wallLabel.clipY + wallLabel.clipHeight, "wall label cannot escape strip bounds");
const ladderSnapshot = {
  sourceBook: {
    exchange: "bybit",
    symbol: "BTCUSDT",
    time: 1,
    bids: Array.from({ length: 200 }, (_, index) => ({ price: 64_000 - index * 0.5, quantity: 1 + index / 20 })),
    asks: Array.from({ length: 200 }, (_, index) => ({ price: 64_000.5 + index * 0.5, quantity: 1.5 + index / 18 }))
  },
  bids: [],
  asks: [],
  bestBid: 64_000,
  bestAsk: 64_000.5,
  midPrice: 64_000.25,
  lastPrice: 64_000.25,
  renderStats: { bucketSize: 50 }
} as unknown as AggregatedDomSnapshot;
const ladderModel = buildDomLadderModel(ladderSnapshot, 40);
const ladderAbove = ladderModel.rows.filter((row) => row.price > ladderSnapshot.midPrice!);
const ladderBelow = ladderModel.rows.filter((row) => row.price <= ladderSnapshot.midPrice!);
assert.equal(ladderModel.rows.length, 40, "ladder creates a balanced market-centered row set");
assert.ok(ladderModel.priceStep < 100, "ladder step follows live book coverage rather than the macro heatmap camera");
assert.ok(ladderAbove.every((row) => row.askSize > 0), "dense live asks populate every visible offer row");
assert.ok(ladderBelow.every((row) => row.bidSize > 0), "dense live bids populate every visible bid row");
assert.ok(ladderModel.rows.every((row) => row.bidDepth >= 0 && row.bidDepth <= 1 && row.askDepth >= 0 && row.askDepth <= 1), "ladder depth bars remain normalized");
assert.ok(ladderModel.rows.some((row) => row.isBestBid) && ladderModel.rows.some((row) => row.isBestAsk), "best bid and ask remain marked after aggregation");
assert.equal(writeDomProLayout(resized, "primary", storage), true);
assert.equal(readDomProLayout("desk", "primary", storage).rootSplit.ratio, 0.60, "layout ratios persist and restore");
assert.equal(saveDomProLayoutPreset(resized, "My Desk", storage), true);
assert.deepEqual(listDomProLayoutPresets("desk", storage), ["My Desk"]);
assert.equal(readDomProLayoutPreset("desk", "My Desk", storage)?.rootSplit.ratio, 0.60, "custom layout preset restores");
storage.setItem("bt:dom-pro-layout:v1:legacy:primary", JSON.stringify({ version: 0, workspaceId: "legacy" }));
assert.equal(readDomProLayout("legacy", "primary", storage).version, 1, "unsupported layout schemas reset through migration boundary");
const layoutSource = readFileSync(new URL("../src/modules/dom-pro/domWorkspaceLayout.ts", import.meta.url), "utf8");
assert.ok(!/DomAggregationEngine|aggregateDomSnapshot|useDomFeed/.test(layoutSource), "layout resizing cannot import or recalculate market analytics");
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
