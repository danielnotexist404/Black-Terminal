import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertKioseffFixtureContract,
  assertKioseffParityDataset,
  type KioseffParityFixture
} from "../src/modules/kioseff-stop-loss-clustering/testing/fixtureTypes.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";

const schema = JSON.parse(
  readFileSync(new URL("../tests/fixtures/kioseff-stop-loss-clustering/schema.json", import.meta.url), "utf8")
) as { required: string[]; properties: Record<string, unknown> };
const goldenManifest = JSON.parse(
  readFileSync(new URL("../tests/golden/kioseff/manifest.json", import.meta.url), "utf8")
) as {
  certificationStatus: string;
  rows: Array<{ id: string; status: string; referenceFile: string | null }>;
};

for (const required of [
  "venue",
  "rawSymbol",
  "normalizedSymbol",
  "assetClass",
  "tickSize",
  "chartTimeframe",
  "lowerTimeframe",
  "sourceRevision",
  "provenance",
  "warmup",
  "inputs",
  "bars",
  "tradingViewReference"
]) {
  assert.ok(schema.required.includes(required), `schema requires ${required}`);
}

const structural: KioseffParityFixture = {
  schemaVersion: 1,
  id: "contract-only",
  certification: "structural",
  venue: "bybit",
  rawSymbol: "BTCUSDT",
  normalizedSymbol: "BTCUSDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.10",
  chartTimeframe: "5m",
  lowerTimeframe: "1m",
  timezone: "UTC",
  sessionPolicy: "continuous-utc",
  source: "fixture",
  sourceRevision: "contract-v1",
  provenance: {
    historicalVenue: "bybit",
    realtimeVenue: "bybit",
    transport: "fixture",
    normalizedBy: "kioseff-fixture-v1"
  },
  warmup: { start: 0, end: 0, requestedChartBars: 0, loadedChartBars: 0 },
  inputs: {
    model: "Absorbtion Extremes",
    granularity: "Lower",
    values: {}
  },
  qualityFlags: [],
  bars: [],
  tradingViewReference: {
    status: "unavailable",
    provider: null,
    exportedAt: null,
    snapshots: [],
    currentBarRevisions: [],
    notes: ["Contract-only structural fixture; no parity claim"]
  }
};

assert.doesNotThrow(() => assertKioseffFixtureContract(structural));
assert.throws(
  () =>
    assertKioseffFixtureContract({
      ...structural,
      certification: "tradingview-certified",
      tradingViewReference: { ...structural.tradingViewReference, status: "unavailable" }
    }),
  /certified fixtures require/
);

const fixtureCandle = (time: number) => ({
  originalTime: time,
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10
});
const dataset = {
  symbol: "BTCUSDT",
  venue: "bybit",
  marketKind: "perpetual",
  chartTimeframe: "4h",
  lowerTimeframe: "1m",
  chartBars: [fixtureCandle(0), fixtureCandle(14_400)],
  lowerTimeframeBars: [fixtureCandle(0), fixtureCandle(60)],
  terminalTimestamp: 14_400,
  tickSize: "0.10",
  settings: structuredClone(KIOSEFF_DEFAULT_SETTINGS)
};
assert.doesNotThrow(() => assertKioseffParityDataset(dataset));
assert.throws(
  () => assertKioseffParityDataset({
    ...dataset,
    lowerTimeframeBars: [fixtureCandle(60), fixtureCandle(0)]
  }),
  /strictly chronological/
);
assert.throws(
  () => assertKioseffParityDataset({
    ...dataset,
    lowerTimeframeBars: [fixtureCandle(0), fixtureCandle(0)]
  }),
  /duplicate timestamp/
);

assert.equal(goldenManifest.certificationStatus, "pending-reference");
assert.equal(goldenManifest.rows.length, 5);
assert.equal(new Set(goldenManifest.rows.map((row) => row.id)).size, 5);
assert.ok(
  goldenManifest.rows.every(
    (row) => row.status === "pending-reference" && row.referenceFile === null
  ),
  "golden manifest must not fabricate TradingView references"
);

console.log("Kioseff fixture contract tests passed (structural; parity reference unavailable).");
