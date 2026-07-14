import assert from "node:assert/strict";
import type { Candle } from "../src/chart-engine/types.ts";
import type { MarketSymbol } from "../src/market-data/types.ts";
import { normalizeAifCandles } from "../src/modules/aif/core/aifDataNormalizer.ts";
import { createAuctionDomain, bucketIndexForPrice } from "../src/modules/aif/core/aifAuctionDomain.ts";
import { AIF_SETTINGS_PRESETS, defaultAifSettings, migrateAifSettings } from "../src/modules/aif/state/aifStore.ts";
import type { AifLvnZone } from "../src/modules/aif/core/aifTypes.ts";
import { calculateAifProfile, pressureShare } from "../src/modules/aif/profiles/profileCalculators.ts";
import { calculateAif } from "../src/modules/aif/core/aifEngine.ts";
import { AifBoundedCache } from "../src/modules/aif/state/aifCache.ts";
import { AIF_PROFILE_REGISTRY, implementedAifProfiles } from "../src/modules/aif/profiles/aifProfileRegistry.ts";
import { VolumeProfileModel } from "../src/chart-engine/profile/VolumeProfileModel.ts";
import { defaultVolumeProfileSettings } from "../src/chart-engine/profile/volumeProfileDefaults.ts";
import { buildAifTimeline } from "../src/modules/aif/events/aifEventEngine.ts";
import { mergeAifLvnZoneMemory, mergeAifResearchMemory } from "../src/modules/aif/nodes/aifNodeMemory.ts";
import { priceToScreenY, screenYToPrice, type ChartPriceTransformSnapshot } from "../src/chart-engine/priceTransform.ts";
import { normalizeWidths, projectAifPriceLine, projectAifProfileRows } from "../src/modules/aif/rendering/aifPriceGeometry.ts";
import { selectCompletedAifCandles } from "../src/modules/aif/core/aifTime.ts";
import { extractStructuralLowActivityZones, type StructuralZoneSettings } from "../src/profile-core/structuralZones.ts";
import { applyAifLvnLifecycle, selectProjectedAifLvns } from "../src/modules/aif/nodes/aifLvnZones.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const symbol: MarketSymbol = { exchange: "bybit", rawSymbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", marketKind: "perpetual" };
const candles = syntheticCandles(4000);
const settings = defaultAifSettings();
assert.equal(settings.lookbackBars, 20_000, "A.I.F. automatically initializes with a 20,000-bar horizon");
settings.lookbackBars = 5000;
settings.rowCount = 180;
const normalized = normalizeAifCandles(candles, settings.lookbackBars, 60);
assert.equal(normalized.coverage.requestedLookbackBars, 5000);
assert.equal(normalized.coverage.effectiveLookbackBars, 4000);
assert.equal(normalized.coverage.wasClamped, true);
assert.equal(normalized.coverage.clampReason, "HISTORICAL COVERAGE LIMIT");

const domain = createAuctionDomain(normalized, settings, candles.at(-1)!.close, "volume");
assert.equal(bucketIndexForPrice(domain, domain.domainMin), 0);
assert.equal(bucketIndexForPrice(domain, domain.domainMax), domain.bucketCount - 1);
assert.ok(domain.boundaries.every((value, index) => index === 0 || value > domain.boundaries[index - 1]), "log boundaries are monotonic");

const provenance = { ...normalized.coverage, venue: "bybit", symbol: "BTCUSDT", marketType: "perpetual", timeframe: "1m", sourceType: "chart-candles" as const, sourceResolution: "1m", profileType: "volume" as const, profileVersion: "1", bucketMethod: settings.bucketMode, allocationMethod: "test", quality: "estimated" as const, engineVersion: "test", calculatedAt: 1 };
const volume = calculateAifProfile("volume", normalized, domain, settings, provenance);
const inputVolume = normalized.candles.reduce((sum, candle) => sum + candle.volume, 0);
assert.ok(Math.abs(volume.total - inputVolume) < Math.max(1e-6, inputVolume * 1e-10), "volume allocation is conserved");
assert.ok(volume.poc && volume.vah && volume.val && volume.vah >= volume.poc && volume.val <= volume.poc);

const flat = normalizeAifCandles([{ time: 60, open: 100, high: 100, low: 100, close: 100, volume: 42 }, { time: 120, open: 100, high: 100, low: 100, close: 100, volume: 8 }], 2, 60);
const flatDomain = createAuctionDomain(flat, { ...settings, logarithmic: false, bucketMode: "fixed-rows" }, 100, "volume");
const flatProfile = calculateAifProfile("volume", flat, flatDomain, settings, { ...provenance, ...flat.coverage });
assert.equal(flatProfile.total, 50, "zero-range candles occupy one bucket without phantom volume");
assert.ok(pressureShare({ time: 1, open: 100, high: 110, low: 90, close: 105, volume: 1 }) > 0.5);

for (const profile of implementedAifProfiles()) {
  const model = calculateAif({ id: 1, generation: 1, marketSymbol: symbol, timeframe: "1m", candles, currentPrice: candles.at(-1)!.close, settings: { ...settings, primaryProfile: profile.id }, sourceVersion: "fixture" });
  assert.equal(model.profileHistogram.profileType, profile.id);
  assert.ok(model.profileHistogram.rows.length >= 10);
  assert.equal(model.provenance.effectiveLookbackBars, candles.length);
  assert.ok(model.timelineEvents.every((event, index, values) => index === 0 || event.time >= values[index - 1].time));
}
assert.equal(AIF_PROFILE_REGISTRY.find((profile) => profile.id === "absorption")?.readiness, "blocked-data");

const comparison = calculateAif({ id: 2, generation: 2, marketSymbol: symbol, timeframe: "1m", candles, currentPrice: candles.at(-1)!.close, settings: { ...settings, primaryProfile: "volume", secondaryProfile: "delta" }, sourceVersion: "fixture" });
assert.equal(comparison.secondaryProfile?.profileType, "delta");
assert.ok(comparison.primaryNodes.every((node) => Number.isFinite(node.confidence) && node.id.length > 0));
assert.equal(comparison.auctionStateSummary.imm, "UNAVAILABLE");
const testNode = { ...comparison.primaryNodes[0], id: "fixture-node", low: 99, high: 101, center: 100, weightedCenter: 100, confidence: 90, status: "untested" as const, touchCount: 0, tested: false };
const interactionCandles: Candle[] = [
  { time: 60, open: 100, high: 102, low: 99, close: 102, volume: 10 },
  { time: 120, open: 102, high: 104, low: 102, close: 104, volume: 10 },
  { time: 180, open: 104, high: 105, low: 103, close: 105, volume: 10 },
  { time: 240, open: 102, high: 102, low: 99, close: 102, volume: 10 },
  { time: 300, open: 102, high: 102, low: 99, close: 102, volume: 10 }
];
const lifecycle = buildAifTimeline(interactionCandles, [testNode], 100, 50, provenance);
assert.ok(lifecycle.events.some((event) => event.type === "node-rejected"), "qualified rejection creates an event");
assert.equal(new Set(lifecycle.events.map((event) => event.id)).size, lifecycle.events.length, "timeline IDs are deduplicated");

const cache = new AifBoundedCache<number>(3);
for (let index = 0; index < 10; index += 1) cache.set(String(index), index);
assert.equal(cache.size, 3, "A.I.F. cache is bounded");
assert.equal(cache.get("0"), undefined, "old cache entries are evicted");
assert.equal(migrateAifSettings({ lookbackBars: 30000 }).lookbackBars, 30000);
const migrated = migrateAifSettings({ rowCount: 99999, lvnMinimumWidthRows: 8, lvnMaximumWidthRows: 2, secondaryProfile: "volume", primaryProfile: "volume" });
assert.equal(migrated.rowCount, 2000, "settings migration clamps pathological row counts");
assert.equal(migrated.lvnMaximumWidthRows, 8, "maximum LVN width cannot fall below minimum width");
assert.equal(migrated.secondaryProfile, "off", "duplicate profile comparison is rejected");
assert.ok(Object.keys(AIF_SETTINGS_PRESETS).includes("HDLX-Inspired Structural"), "documented structural preset is available");
const memoryStorage = new MemoryStorage();
const memory = mergeAifResearchMemory("fixture", comparison.primaryNodes.slice(0, 2), comparison.timelineEvents, memoryStorage);
assert.ok(memory.nodes.length <= 300 && memory.events.length <= 500, "research memory remains bounded");

const linearTransform: ChartPriceTransformSnapshot = {
  revision: 1, width: 1200, height: 700, plotLeft: 0, plotRight: 1112, plotTop: 38, plotBottom: 642,
  priceMin: 20_000, priceMax: 30_000, scaleMode: "linear", firstIndex: 0, lastIndex: 500
};
const linearY = priceToScreenY(25_000, linearTransform);
assert.equal(linearY, 340, "linear price transform uses the chart plot bounds");
assert.ok(Math.abs((screenYToPrice(linearY!, linearTransform) ?? 0) - 25_000) < 1e-9, "linear transform round-trips");
const logTransform = { ...linearTransform, scaleMode: "logarithmic" as const };
const logY = priceToScreenY(25_000, logTransform);
assert.ok(logY != null && Math.abs((screenYToPrice(logY, logTransform) ?? 0) - 25_000) < 1e-8, "logarithmic transform round-trips");

const modelBeforeGeometry = JSON.stringify(comparison);
const projected = projectAifProfileRows(volume.rows, linearTransform, (price) => priceToScreenY(price, linearTransform));
assert.ok(projected.length > 0 && projected.every((row) => row.top >= linearTransform.plotTop && row.top + row.height <= linearTransform.plotBottom + 1), "profile geometry is clipped to the chart plot");
const shiftedTransform = { ...linearTransform, revision: 2, priceMin: 21_000, priceMax: 31_000 };
const testPrice = 25_000;
const originalLineY = projectAifPriceLine(testPrice, linearTransform, (price) => priceToScreenY(price, linearTransform));
const shiftedLineY = projectAifPriceLine(testPrice, shiftedTransform, (price) => priceToScreenY(price, shiftedTransform));
assert.ok(originalLineY != null && shiftedLineY != null && Math.abs((shiftedLineY - originalLineY) - 60.4) < 1e-9, "A.I.F. levels follow vertical chart panning exactly");
assert.equal(JSON.stringify(comparison), modelBeforeGeometry, "camera geometry does not mutate or recalculate the A.I.F. model");
for (const mode of ["raw", "percent-max", "percentile", "z-score", "robust-z-score", "log"] as const) {
  const widths = normalizeWidths([1, 4, 16, 64], mode);
  assert.equal(widths.length, 4);
  assert.ok(widths.every((value) => Number.isFinite(value) && value >= 0 && value <= 1), `${mode} normalization remains bounded`);
  assert.ok(widths[3] >= widths[0], `${mode} normalization preserves activity ordering`);
}

const structuralSettings: StructuralZoneSettings = {
  method: "percentile", percentileThreshold: 45, relativePocThreshold: 0.2, robustZThreshold: -0.8,
  neighborWindow: 2, minimumNeighborContrast: 2, minimumContiguousRows: 2, maximumInternalGapRows: 0,
  minimumWidthRows: 2, maximumWidthRows: 8, mergeDistanceRows: 1, edgeExclusionRows: 1, minimumScore: 40
};
const structuralRows = [100, 90, 8, 5, 7, 92, 105].map((activity, index) => ({ index, low: 100 + index, high: 101 + index, center: 100.5 + index, activity }));
const structuralZones = extractStructuralLowActivityZones(structuralRows, structuralSettings);
assert.equal(structuralZones.length, 1, "contiguous low-activity rows merge into one bounded LVN zone");
assert.deepEqual([structuralZones[0].low, structuralZones[0].high, structuralZones[0].widthRows], [102, 105, 3]);
assert.equal(structuralZones[0].minimumActivityPrice, 103.5, "zone retains its minimum-activity price");
assert.ok(structuralZones[0].weightedCenter >= structuralZones[0].low && structuralZones[0].weightedCenter <= structuralZones[0].high);
assert.equal(extractStructuralLowActivityZones(structuralRows, { ...structuralSettings, minimumNeighborContrast: 100 }).length, 0, "weak structural contrast is rejected");

const fixtureStructure = structuralZones[0];
const zoneTemplate: AifLvnZone = {
  id: "fixture-zone", venue: "bybit", symbol: "BTCUSDT", timeframe: "1m", profileType: "volume",
  low: fixtureStructure.low, high: fixtureStructure.high, center: fixtureStructure.center, weightedCenter: fixtureStructure.weightedCenter,
  minimumActivityPrice: fixtureStructure.minimumActivityPrice, widthAbsolute: fixtureStructure.widthAbsolute, widthPercent: fixtureStructure.widthPercent,
  widthTicks: fixtureStructure.widthRows, rawActivity: fixtureStructure.rawActivity, normalizedActivity: fixtureStructure.normalizedActivity,
  activityPercentile: fixtureStructure.activityPercentile, neighborContrast: fixtureStructure.neighborContrast, valleyDepth: fixtureStructure.valleyDepth,
  strength: fixtureStructure.structuralScore, stability: 90, confidence: 90, score: 0, requestedLookback: 5000, effectiveLookback: 4000,
  sourceResolution: "1m", dataQuality: "estimated", detectionMethod: fixtureStructure.method, algorithmVersion: fixtureStructure.algorithmVersion,
  firstObserved: 1, lastObserved: 1, touchCount: 0, rejectionCount: 0, acceptanceCount: 0, state: "qualified", projected: false,
  invalidated: false, provenance
};
const rankedZones = Array.from({ length: 8 }, (_, index) => ({ ...zoneTemplate, id: `ranked-${index}`, low: 100 + index * 4, high: 102 + index * 4, center: 101 + index * 4, widthAbsolute: 2, strength: 92 - index, stability: 90, confidence: 90, neighborContrast: 3, score: 0, state: "qualified" as const, invalidated: false }));
const projectionSettings = { ...settings, futureLvnMaxAbove: 2, futureLvnMaxBelow: 1, futureLvnMaxTotal: 3, futureLvnMinimumScore: 0, futureLvnMinimumStability: 0, futureLvnMinimumConfidence: 0, futureLvnMinimumContrast: 1, lvnMinimumStrength: 0 };
const projectedZones = selectProjectedAifLvns(rankedZones, 112, projectionSettings);
assert.equal(projectedZones.length, 3, "future LVN projection obeys independent above/below and total caps");
assert.equal(projectedZones.filter((zone) => zone.center < 112).length, 1);

const lifecycleZone = { ...zoneTemplate, id: "lifecycle-zone", low: 99, high: 101, center: 100, widthAbsolute: 2, state: "qualified" as const, touchCount: 0, rejectionCount: 0, acceptanceCount: 0, invalidated: false };
const lifecycleCandles: Candle[] = [
  { time: 1, open: 103, high: 104, low: 102, close: 103, volume: 1 },
  { time: 2, open: 102, high: 102.5, low: 100, close: 102, volume: 1 },
  { time: 3, open: 102, high: 102.5, low: 100.5, close: 102, volume: 1 },
  { time: 4, open: 103, high: 104, low: 102, close: 103, volume: 1 },
  { time: 5, open: 104, high: 105, low: 103, close: 104, volume: 1 }
];
const lifecycleZoneResult = applyAifLvnLifecycle([lifecycleZone], lifecycleCandles, { ...settings, timelineHorizon: 100 })[0];
assert.equal(lifecycleZoneResult.touchCount, 1, "multiple candles in one interaction session count as one LVN test");
assert.equal(lifecycleZoneResult.rejectionCount, 1, "a separated failed traversal records one rejection");

const zoneMemoryStorage = new MemoryStorage();
const firstZoneMemory = mergeAifLvnZoneMemory("fixture", [rankedZones[0]], zoneMemoryStorage as unknown as Storage);
const shiftedZone = { ...rankedZones[0], id: "new-quantized-id", low: rankedZones[0].low + 0.2, high: rankedZones[0].high + 0.2, center: rankedZones[0].center + 0.2 };
const secondZoneMemory = mergeAifLvnZoneMemory("fixture", [shiftedZone], zoneMemoryStorage as unknown as Storage);
assert.equal(secondZoneMemory.zones[0].id, firstZoneMemory.zones[0].id, "zone memory preserves identity across small bucket shifts");

const now = 1_700_000_125;
const completionFixture: Candle[] = [
  { time: 1_700_000_000, open: 1, high: 2, low: 1, close: 2, volume: 1 },
  { time: 1_700_000_060, open: 2, high: 3, low: 2, close: 3, volume: 1 },
  { time: 1_700_000_120, open: 3, high: 4, low: 3, close: 4, volume: 1 }
];
assert.deepEqual(selectCompletedAifCandles(completionFixture, "1m", now).map((candle) => candle.time), [1_700_000_000, 1_700_000_060], "automatic anchor excludes the incomplete candle");

const hdlx = new VolumeProfileModel().calculate(candles.slice(0, 600), 0, 599, { ...defaultVolumeProfileSettings, fixedRangeLength: 500, rows: 72 }, { startIndex: 100, endIndex: 599 });
assert.ok(hdlx, "HDLX deterministic fixture calculates");
const hdlxFixture = { rows: hdlx!.rows.length, start: hdlx!.startIndex, end: hdlx!.endIndex, poc: round(hdlx!.pocPrice), vah: round(hdlx!.valueAreaHigh), val: round(hdlx!.valueAreaLow), volume: round(hdlx!.totalVolume), hdlxTail: hdlx!.hdlx.slice(-3).map((point) => round(point.value)) };
assert.deepEqual(hdlxFixture, { rows: 72, start: 100, end: 599, poc: 25082.894459, vah: 26509.482936, val: 24106.807607, volume: 61597.885083, hdlxTail: [-0.108561, -0.103346, -0.098835] }, `HDLX fixture changed: ${JSON.stringify(hdlxFixture)}`);

console.log(`A.I.F. deterministic suite passed (${candles.length.toLocaleString()} candles, ${implementedAifProfiles().length} production lenses).`);

function syntheticCandles(count: number): Candle[] {
  const output: Candle[] = [];
  let close = 24000;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    const drift = Math.sin(index / 37) * 19 + Math.cos(index / 113) * 11 + (index % 17 - 8) * 0.7;
    close = Math.max(100, open + drift);
    const wick = 12 + index % 23;
    output.push({ time: 1_700_000_000 + index * 60, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick * 0.8, close, volume: 15 + (index * 17) % 241 });
  }
  return output;
}

function round(value: number) { return Number(value.toFixed(6)); }
