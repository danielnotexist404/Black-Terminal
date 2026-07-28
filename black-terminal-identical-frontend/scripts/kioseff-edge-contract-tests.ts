import assert from "node:assert/strict";
import type { SymbolMetadata } from "../src/market-data/types.ts";
import { AbsorbtionExtremesEngine } from "../src/modules/kioseff-stop-loss-clustering/core/absorbtionEngine.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import { VolatilityAtEntryEngine } from "../src/modules/kioseff-stop-loss-clustering/core/volatilityAtEntryEngine.ts";
import type {
  IntrabarQualityReport,
  KioseffChartBarInput,
  NormalizedCandle
} from "../src/modules/kioseff-stop-loss-clustering/data/types.ts";

const metadata: SymbolMetadata = {
  exchange: "mock",
  rawSymbol: "EDGEUSDT",
  normalizedSymbol: "EDGE/USDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.1",
  timezone: "UTC",
  sessionPolicy: "24x7",
  source: "edge"
};
const complete: IntrabarQualityReport = {
  complete: true,
  partial: false,
  expectedIntervalSeconds: 60,
  expectedCount: 0,
  actualCount: 0,
  coverageStart: null,
  coverageEnd: null,
  missingTimes: [],
  duplicateTimes: [],
  outOfOrderTimes: [],
  conflictingTimes: [],
  sourceMismatch: false,
  flags: [],
  notes: []
};
function candle(time: number, open: number, high: number, low: number, close: number): NormalizedCandle {
  return {
    time,
    open,
    high,
    low,
    close,
    volume: 100,
    originalTime: time,
    source: "edge",
    sourceRevision: "v1"
  };
}
function input(chartBar: NormalizedCandle): KioseffChartBarInput {
  return {
    chartBar,
    intrabars: [],
    chartBarClosed: true,
    sourceVersion: "edge-v1",
    quality: complete
  };
}
const absorbSettings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
const context = {
  metadata,
  timeframe: "5m" as const,
  sourceVersion: "edge-v1",
  settings: absorbSettings,
  diagnostics: true
};

const equality = new AbsorbtionExtremesEngine(context);
const equalityState = equality.exportState();
equalityState.sell.active.push({
  id: "equality",
  side: "sell-stop",
  volume: -10,
  p: 100,
  p2: 101,
  time: 0,
  violationTime: null,
  intrabarMove: null,
  sourceCount: 1,
  sequence: 0
});
equality.importState(equalityState);
equality.processBar(input(candle(300, 100, 101, 99, 100)));
assert.equal(equality.exportState().sell.active.length, 0, "wick equality violates sell cluster");
assert.equal(equality.exportState().sell.violated.length, 1);

const vaeSettings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
vaeSettings.model = "volatility-at-entry";
vaeSettings.volatilityAtEntry.granularity = "higher";
const vaeContext = { ...context, settings: vaeSettings };
const gap = new VolatilityAtEntryEngine(vaeContext);
const gapState = gap.exportState();
gapState.bars.push(candle(86_100, 100, 101, 99, 100));
gapState.barStats.push({ high: 101, low: 99, time: 86_100 });
gapState.higher.activeKeys.push(1050);
gapState.higher.active.set(1050, {
  volume: 20,
  time: 86_100,
  creationTime: 86_100,
  violationTime: null,
  sequence: 0,
  sourceCount: 1
});
gap.importState(gapState);
gap.processBar(input(candle(86_400, 110, 111, 109, 110)));
assert.equal(gap.exportState().higher.activeKeys.length, 0, "daily opening gap removes crossed key");
assert.equal(gap.exportState().higher.removedKeys.length, 1);

const prune = new VolatilityAtEntryEngine(vaeContext);
const pruneState = prune.exportState();
for (let key = 0; key <= 25_000; key += 1) {
  pruneState.higher.activeKeys.push(key);
  pruneState.higher.active.set(key, {
    volume: 1,
    time: 0,
    creationTime: 0,
    violationTime: null,
    sequence: key,
    sourceCount: 1
  });
}
prune.importState(pruneState);
prune.processBar(input(candle(300, 1250, 1251, 1249, 1250)));
assert.equal(prune.exportState().higher.activeKeys.length, 20_000, "25,001 keys prune to 20,000");
assert.equal(prune.exportState().higher.active.size, 20_000);

const boundary = new VolatilityAtEntryEngine(vaeContext);
const boundaryState = boundary.exportState();
for (let key = 0; key < 25_000; key += 1) {
  boundaryState.higher.activeKeys.push(key);
  boundaryState.higher.active.set(key, {
    volume: 1,
    time: 0,
    creationTime: 0,
    violationTime: null,
    sequence: key,
    sourceCount: 1
  });
}
boundary.importState(boundaryState);
boundary.processBar(input(candle(300, 1250, 1251, 1249, 1250)));
assert.equal(boundary.exportState().higher.activeKeys.length, 25_000, "25,000 keys do not prune");

console.log("Kioseff wick, daily-gap, and pruning-boundary tests passed.");
