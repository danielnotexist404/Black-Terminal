import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertKioseffFixtureContract,
  type KioseffParityFixture
} from "../src/modules/kioseff-stop-loss-clustering/testing/fixtureTypes.ts";

const schema = JSON.parse(
  readFileSync(new URL("../tests/fixtures/kioseff-stop-loss-clustering/schema.json", import.meta.url), "utf8")
) as { required: string[]; properties: Record<string, unknown> };

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

console.log("Kioseff fixture contract tests passed (structural; parity reference unavailable).");

