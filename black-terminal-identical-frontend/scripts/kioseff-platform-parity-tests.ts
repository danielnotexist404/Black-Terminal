import assert from "node:assert/strict";
import type { SymbolMetadata } from "../src/market-data/types.ts";
import { canonicalSnapshotHash } from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import { KioseffParityEngine } from "../src/modules/kioseff-stop-loss-clustering/core/parityEngine.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import type { KioseffChartBarInput, NormalizedCandle } from "../src/modules/kioseff-stop-loss-clustering/data/types.ts";

const metadata: SymbolMetadata = {
  exchange: "mock",
  rawSymbol: "PLATFORMUSDT",
  normalizedSymbol: "PLATFORM/USDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.05",
  timezone: "UTC",
  sessionPolicy: "24x7",
  source: "fixture"
};
const settings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
settings.model = "volatility-at-entry";
settings.volatilityAtEntry.granularity = "higher";
const context = {
  metadata,
  timeframe: "5m" as const,
  sourceVersion: "platform-v1",
  settings,
  diagnostics: false
};

function candle(time: number, value: number): NormalizedCandle {
  return {
    time,
    open: value,
    high: value + 0.2,
    low: value - 0.2,
    close: value + 0.05,
    volume: 10,
    originalTime: new Date(time * 1000).toISOString(),
    source: "fixture",
    sourceRevision: "platform-v1"
  };
}
const fixture: KioseffChartBarInput[] = Array.from({ length: 30 }, (_, index) => ({
  chartBar: candle(index * 300, 100 + index * 0.01),
  intrabars: Array.from({ length: 5 }, (_, minute) =>
    candle(index * 300 + minute * 60, 100 + index * 0.01 + minute * 0.005)
  ),
  chartBarClosed: true,
  sourceVersion: "platform-v1",
  quality: {
    complete: true,
    partial: false,
    expectedIntervalSeconds: 60,
    expectedCount: 5,
    actualCount: 5,
    coverageStart: index * 300,
    coverageEnd: index * 300 + 240,
    missingTimes: [],
    duplicateTimes: [],
    outOfOrderTimes: [],
    conflictingTimes: [],
    sourceMismatch: false,
    flags: [],
    notes: []
  }
}));

const browserTransport = JSON.parse(JSON.stringify(fixture)) as KioseffChartBarInput[];
const tauriTransport = structuredClone(fixture);
const browserEngine = new KioseffParityEngine(context);
const tauriEngine = new KioseffParityEngine(context);
const browserHash = canonicalSnapshotHash(browserEngine.processBatch(browserTransport));
const tauriHash = canonicalSnapshotHash(tauriEngine.processBatch(tauriTransport));
assert.equal(browserHash, tauriHash);

console.log(`Kioseff browser/Tauri normalized fixture hash matched: ${browserHash}`);
