import assert from "node:assert/strict";
import {
  KIOSEFF_ENGINE_VERSION,
  KIOSEFF_SCHEMA_VERSION,
  canonicalClusterHash,
  canonicalSnapshotHash,
  emptyRatioModel,
  type CanonicalCluster,
  type KioseffSnapshot
} from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import {
  KIOSEFF_PINE_ACTIVE_OBJECT_CAP,
  buildKioseffRenderModel,
  formatPineVolume,
  interpolateHexColor,
  kioseffPriceDomain,
  layoutKioseffLabels
} from "../src/modules/kioseff-stop-loss-clustering/rendering/renderModel.ts";
import { buildMarketMakerActivityDashboard } from "../src/modules/kioseff-stop-loss-clustering/components/marketMakerDashboardModel.ts";

function cluster(index: number, side: "buy-stop" | "sell-stop", state: "active" | "violated"): CanonicalCluster {
  return {
    id: `${side}:${index}:${state}`,
    side,
    state,
    signedVolume: side === "buy-stop" ? index + 1 : -(index + 1),
    absoluteVolume: index + 1,
    price: 100 + index,
    priceLow: 99.5 + index,
    priceHigh: 100.5 + index,
    tickIndex: null,
    creationTime: index,
    startTime: index,
    violationTime: state === "violated" ? index + 10 : null,
    endTime: state === "violated" ? index + 10 : null,
    strength: null,
    percentileValue: null,
    strengthNormalized: null,
    hot: index % 2 === 0,
    sourceCount: 1,
    opacity: null,
    granularity: null,
    historicalTrigger: state === "violated",
    createdAtBarIndex: index,
    violatedAtBarIndex: state === "violated" ? index + 10 : null,
    sourceEngineVersion: KIOSEFF_ENGINE_VERSION
  };
}

const snapshot: KioseffSnapshot = {
  schemaVersion: KIOSEFF_SCHEMA_VERSION,
  engineVersion: KIOSEFF_ENGINE_VERSION,
  model: "absorbtion-extremes",
  symbol: { exchange: "mock", rawSymbol: "TEST", assetClass: "crypto", tickSize: "0.5" },
  timeframe: "5m",
  sourceVersion: "render",
  committedThrough: 10,
  provisionalBarTime: null,
  activeClusters: [
    ...Array.from({ length: 5 }, (_, index) => cluster(index, "buy-stop", "active")),
    ...Array.from({ length: 5 }, (_, index) => cluster(index, "sell-stop", "active"))
  ],
  violatedClusters: [
    ...Array.from({ length: 5 }, (_, index) => cluster(index, "buy-stop", "violated")),
    ...Array.from({ length: 5 }, (_, index) => cluster(index, "sell-stop", "violated"))
  ],
  qCurves: [],
  outputs: {
    buyStopsHit: null,
    sellStopsHit: null,
    buyStopsAverage: null,
    sellStopsAverage: null,
    nearestBuy: null,
    nearestSell: null,
    activeBuyTotal: 0,
    activeSellTotal: 0,
    violatedBuyTotal: 0,
    violatedSellTotal: 0,
    typicalBuyMove: null,
    typicalSellMove: null,
    radiateBuy: false,
    radiateSell: false
  },
  pane: [{
    time: 10,
    buyStopsHit: 2,
    sellStopsHit: -3,
    buyAverage: 1,
    sellAverage: -1,
    radiateBuy: true,
    radiateSell: false
  }],
  alerts: [],
  summary: { nearestBuy: null, nearestSell: null },
  ratioMeter: emptyRatioModel(),
  diagnostics: []
};
const before = canonicalSnapshotHash(snapshot);
const settings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
settings.absorbtion.stopClusterBuys = 2;
settings.absorbtion.stopClusterSells = 3;
settings.absorbtion.oldStopClusterBuys = 1;
settings.absorbtion.oldStopClusterSells = 2;
const renderModel = buildKioseffRenderModel(snapshot, settings);
assert.equal(renderModel.activeZones.filter((zone) => zone.side === "buy-stop").length, 2);
assert.equal(renderModel.activeZones.filter((zone) => zone.side === "sell-stop").length, 3);
assert.equal(renderModel.violatedZones.filter((zone) => zone.side === "buy-stop").length, 1);
assert.equal(renderModel.violatedZones.filter((zone) => zone.side === "sell-stop").length, 2);
assert.ok(renderModel.xRay);
assert.ok(renderModel.activeZones.length > 0);
assert.ok(renderModel.violatedZones.length > 0);
assert.equal(renderModel.pane.length, 0, "oscillator is hidden by default");
assert.ok(renderModel.geometryCommandCount > 0, "render smoke emits visible geometry commands");
assert.ok(snapshot.summary, "render smoke retains a summary model");
assert.equal(canonicalSnapshotHash(snapshot), before, "render selection cannot mutate canonical state");
const activityDashboard = buildMarketMakerActivityDashboard(snapshot, 102);
assert.equal(activityDashboard.nearestBuyWall?.price, 104);
assert.equal(activityDashboard.nearestSellWall?.price, 100);
assert.equal(activityDashboard.violatedEventCount, 10);
assert.equal(activityDashboard.totalLiquidationPressure, 30);
assert.ok(
  activityDashboard.nearestSellWall,
  "dashboard finds the nearest active sell wall even when the parity hot summary is empty"
);

settings.style.showOscillator = true;
const oscillatorRenderModel = buildKioseffRenderModel(snapshot, settings);
assert.ok(oscillatorRenderModel.pane.length > 0, "oscillator can be enabled from Style settings");

const vae = { ...snapshot, model: "volatility-at-entry" as const, granularity: "higher" as const };
settings.volatilityAtEntry.showHistoricalTriggers = false;
const vaeRender = buildKioseffRenderModel(vae, settings);
assert.equal(vaeRender.violatedZones.length, 0);
assert.equal(vaeRender.xRay, null);
assert.equal(canonicalSnapshotHash(vae), canonicalSnapshotHash({ ...vae }), "zoom/pan-free render inputs remain state invariant");

const weak = {
  ...cluster(0, "sell-stop", "active"),
  strength: "weak" as const,
  strengthNormalized: 0.25,
  opacity: 0.04,
  granularity: "lower" as const
};
const strong = {
  ...cluster(1, "sell-stop", "active"),
  strength: "strong" as const,
  strengthNormalized: 0.9,
  opacity: 0.095,
  granularity: "lower" as const
};
const denseVae = {
  ...vae,
  granularity: "lower" as const,
  activeClusters: [weak, strong],
  violatedClusters: [{ ...weak, id: "historical", state: "violated" as const, endTime: 20 }]
};
settings.volatilityAtEntry.showHistoricalTriggers = true;
settings.volatilityAtEntry.showActiveClusterSize = true;
const continuous = buildKioseffRenderModel(denseVae, settings);
assert.notEqual(
  continuous.activeZones[0]!.color,
  settings.volatilityAtEntry.weakClusterColor,
  "weak Pine clusters interpolate continuously from chart background"
);
assert.equal(continuous.activeZones[0]!.opacity, 0.04);
assert.equal(
  continuous.activeZones[0]!.labelColor,
  settings.volatilityAtEntry.weakClusterColor,
  "weak label text uses Pine's static weak color rather than the dark fill gradient"
);
assert.equal(continuous.violatedZones[0]!.drawAsLine, true);
assert.equal(continuous.violatedZones[0]!.opacity, 0.5);
const visibleBuy = {
  ...weak,
  id: "visible-buy-wall",
  side: "buy-stop" as const,
  signedVolume: 4240,
  absoluteVolume: 4240
};
const buyVisibilityRender = buildKioseffRenderModel(
  { ...denseVae, activeClusters: [visibleBuy], violatedClusters: [] },
  settings
);
assert.equal(buyVisibilityRender.activeZones[0]!.labelText, "4.24K");
assert.equal(buyVisibilityRender.activeZones[0]!.labelColor, settings.style.buyWallColor);
assert.ok(
  (buyVisibilityRender.activeZones[0]!.opacity ?? 0) >= 0.14,
  "weak buy walls retain a readable minimum opacity"
);
assert.notEqual(
  buyVisibilityRender.activeZones[0]!.color,
  settings.style.chartBackgroundColor,
  "buy wall fill cannot disappear into the chart background"
);
assert.equal(interpolateHexColor("#000000", "#ffffff", 0.5), "#808080");
assert.equal(formatPineVolume(4240), "4.24K");
assert.equal(formatPineVolume(-12_070), "-12.07K");
assert.equal(KIOSEFF_PINE_ACTIVE_OBJECT_CAP, 496);
const capacitySnapshot = {
  ...denseVae,
  activeClusters: Array.from({ length: KIOSEFF_PINE_ACTIVE_OBJECT_CAP }, (_, index) => ({
    ...weak,
    id: `capacity-${index}`,
    price: 100 + index * 0.01,
    priceLow: 99.995 + index * 0.01,
    priceHigh: 100.005 + index * 0.01
  })),
  violatedClusters: []
};
const capacityRender = buildKioseffRenderModel(capacitySnapshot, settings);
assert.equal(capacityRender.activeZones.length, 496);
assert.equal(
  capacityRender.activeZones.filter((zone) => zone.showLabel).length,
  496,
  "Pine compatibility does not silently truncate active labels at 120"
);
const collisionZones = [
  { ...capacityRender.activeZones[0]!, id: "weak-collision", price: 20, absoluteVolume: 1, hot: false },
  { ...capacityRender.activeZones[1]!, id: "strong-collision", price: 22, absoluteVolume: 100, hot: true },
  { ...capacityRender.activeZones[2]!, id: "separate", price: 50, absoluteVolume: 2, hot: false }
];
const labelLayout = layoutKioseffLabels(collisionZones, (price) => price, 0, 100, 9);
assert.deepEqual(
  labelLayout.map(({ zone }) => zone.id),
  ["weak-collision", "strong-collision", "separate"],
  "every visible active wall retains its own exact label instead of competing for a screen row"
);
assert.ok(
  labelLayout.every(({ zone, y }) => y === zone.price),
  "collision handling never shifts a label away from its cluster price"
);
const fullScaleLayout = layoutKioseffLabels(
  capacityRender.activeZones.map((zone, index, zones) => ({
    ...zone,
    price: (index / (zones.length - 1)) * 100,
    absoluteVolume: zones.length - index,
    hot: index < 20
  })),
  (price) => price,
  0,
  100,
  9
);
assert.ok(fullScaleLayout.length >= 8, "dense labels occupy multiple readable screen rows");
assert.ok(fullScaleLayout[0]!.y <= 6, "label distribution reaches the top of the visible scale");
assert.ok(fullScaleLayout.at(-1)!.y >= 94, "label distribution reaches the bottom of the visible scale");
assert.equal(
  fullScaleLayout.length,
  KIOSEFF_PINE_ACTIVE_OBJECT_CAP,
  "dense exact-price labels are never replaced by viewport-dependent collision winners"
);
const verticallyPannedLayout = layoutKioseffLabels(
  capacityRender.activeZones,
  (price) => price + 40,
  139,
  146,
  9
);
assert.deepEqual(
  verticallyPannedLayout.map(({ zone }) => [zone.id, zone.labelText]),
  layoutKioseffLabels(capacityRender.activeZones, (price) => price, 99, 106, 9)
    .map(({ zone }) => [zone.id, zone.labelText]),
  "vertical panning preserves the permanent wall-ID to active-size association"
);

const domain = kioseffPriceDomain(denseVae, settings, 99, 101, 0, 100);
assert.ok(domain.maximum >= strong.priceHigh, "visible cluster geometry participates in price domain");
const hashBeforeCameraChanges = canonicalClusterHash(denseVae);
for (const camera of [
  [0, 100],
  [5, 20],
  [0, 10_000],
  [15, 25],
  [null, null]
] as const) {
  kioseffPriceDomain(denseVae, settings, 90, 110, camera[0], camera[1]);
  assert.equal(canonicalClusterHash(denseVae), hashBeforeCameraChanges);
}

console.log("Kioseff canonical render-model tests passed.");
