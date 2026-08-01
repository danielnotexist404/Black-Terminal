import assert from "node:assert/strict";
import {
  KIOSEFF_ENGINE_VERSION,
  KIOSEFF_SCHEMA_VERSION,
  canonicalSnapshotHash,
  emptyRatioModel,
  type CanonicalCluster,
  type KioseffSnapshot
} from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import { buildKioseffRenderModel } from "../src/modules/kioseff-stop-loss-clustering/rendering/renderModel.ts";

function cluster(index: number, side: "buy-stop" | "sell-stop", state: "active" | "violated"): CanonicalCluster {
  return {
    id: `${side}:${index}:${state}`,
    side,
    state,
    signedVolume: side === "buy-stop" ? index + 1 : -(index + 1),
    price: 100 + index,
    priceLow: 99.5 + index,
    priceHigh: 100.5 + index,
    tickIndex: null,
    creationTime: index,
    startTime: index,
    violationTime: state === "violated" ? index + 10 : null,
    endTime: state === "violated" ? index + 10 : null,
    strength: null,
    hot: index % 2 === 0,
    sourceCount: 1,
    opacity: null
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
assert.ok(renderModel.pane.length > 0);
assert.ok(renderModel.geometryCommandCount > 0, "render smoke emits visible geometry commands");
assert.ok(snapshot.summary, "render smoke retains a summary model");
assert.equal(canonicalSnapshotHash(snapshot), before, "render selection cannot mutate canonical state");

const vae = { ...snapshot, model: "volatility-at-entry" as const, granularity: "higher" as const };
settings.volatilityAtEntry.showHistoricalTriggers = false;
const vaeRender = buildKioseffRenderModel(vae, settings);
assert.equal(vaeRender.violatedZones.length, 0);
assert.equal(vaeRender.xRay, null);
assert.equal(canonicalSnapshotHash(vae), canonicalSnapshotHash({ ...vae }), "zoom/pan-free render inputs remain state invariant");

console.log("Kioseff canonical render-model tests passed.");
