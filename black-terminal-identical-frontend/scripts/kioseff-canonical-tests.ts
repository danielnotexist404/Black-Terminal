import assert from "node:assert/strict";
import {
  KIOSEFF_ENGINE_VERSION,
  KIOSEFF_SCHEMA_VERSION,
  canonicalClusterId,
  canonicalSnapshotHash,
  emptyRatioModel,
  stableCanonicalJson,
  type KioseffSnapshot
} from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import {
  KIOSEFF_DEFAULT_SETTINGS,
  migrateKioseffSettings
} from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";

const base: KioseffSnapshot = {
  schemaVersion: KIOSEFF_SCHEMA_VERSION,
  engineVersion: KIOSEFF_ENGINE_VERSION,
  model: "absorbtion-extremes",
  symbol: { exchange: "binance", rawSymbol: "BTCUSDT", assetClass: "crypto", tickSize: "0.1" },
  timeframe: "5m",
  sourceVersion: "source",
  committedThrough: null,
  provisionalBarTime: null,
  activeClusters: [],
  violatedClusters: [],
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
  pane: [],
  alerts: [],
  summary: { nearestBuy: null, nearestSell: null },
  ratioMeter: emptyRatioModel(),
  diagnostics: []
};

const first = {
  id: canonicalClusterId({
    model: "absorbtion-extremes",
    side: "buy-stop",
    priceKey: "100.5",
    creationTime: 100,
    creationSequence: 0
  }),
  side: "buy-stop" as const,
  state: "active" as const,
  signedVolume: 5,
  price: 100.5,
  priceLow: 100,
  priceHigh: 101,
  tickIndex: null,
  creationTime: 100,
  startTime: 90,
  violationTime: null,
  endTime: null,
  strength: null,
  hot: false,
  sourceCount: 1,
  opacity: null
};
const second = { ...first, id: `${first.id}:2`, price: 99, creationTime: 120 };
const unordered = { ...base, activeClusters: [first, second] };
const ordered = { ...base, activeClusters: [second, first] };
assert.equal(canonicalSnapshotHash(unordered), canonicalSnapshotHash(ordered));
assert.equal(stableCanonicalJson(unordered), stableCanonicalJson(ordered));
assert.notEqual(first.id, second.id);
assert.throws(() => canonicalSnapshotHash({ ...base, outputs: { ...base.outputs, activeBuyTotal: NaN } }));

assert.equal(KIOSEFF_DEFAULT_SETTINGS.absorbtion.stopClusterBuys, 2);
assert.equal(KIOSEFF_DEFAULT_SETTINGS.volatilityAtEntry.granularity, "lower");
assert.equal(migrateKioseffSettings({ period: 200 }).model, "absorbtion-extremes");
assert.equal(
  migrateKioseffSettings({
    version: 1,
    model: "volatility-at-entry",
    absorbtion: { stopClusterBuys: 7 },
    volatilityAtEntry: {}
  }).absorbtion.stopClusterBuys,
  7
);

console.log("Kioseff canonical output tests passed.");
