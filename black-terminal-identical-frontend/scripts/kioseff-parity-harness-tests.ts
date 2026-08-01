import assert from "node:assert/strict";
import {
  firstCanonicalDifference,
  runKioseffParityFixture,
  settingsFromKioseffFixture
} from "../src/modules/kioseff-stop-loss-clustering/testing/parityHarness.ts";
import type { KioseffParityFixture } from "../src/modules/kioseff-stop-loss-clustering/testing/fixtureTypes.ts";

assert.equal(firstCanonicalDifference({ price: 1 }, { price: 1 + 1e-12 }), null);
assert.equal(
  firstCanonicalDifference({ price: 1 }, { price: 1.01 })?.kind,
  "float-divergence"
);
assert.equal(
  firstCanonicalDifference({ tickIndex: 1 }, { tickIndex: 2 })?.kind,
  "exact-integer-state-divergence"
);
assert.equal(
  firstCanonicalDifference({ values: [1, 2] }, { values: [1] })?.path,
  "$.values.length"
);

const base: KioseffParityFixture = {
  schemaVersion: 1,
  id: "pending-reference-contract",
  certification: "structural",
  venue: "mock",
  rawSymbol: "TESTUSDT",
  normalizedSymbol: "TEST/USDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.1",
  chartTimeframe: "5m",
  lowerTimeframe: "1m",
  timezone: "UTC",
  sessionPolicy: "24x7",
  source: "fixture",
  sourceRevision: "v1",
  provenance: {
    historicalVenue: "mock",
    realtimeVenue: "mock",
    transport: "fixture",
    normalizedBy: "test"
  },
  warmup: { start: 0, end: 300, requestedChartBars: 1, loadedChartBars: 1 },
  inputs: {
    model: "Volatility-At-Entry",
    granularity: "Higher (Heavy)",
    values: {}
  },
  qualityFlags: [],
  bars: [
    {
      chartBar: {
        originalTime: 0,
        time: 0,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100
      },
      intrabars: [
        {
          originalTime: 0,
          time: 0,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 100
        }
      ],
      chartBarClosed: true,
      sourceVersion: "v1",
      quality: {
        complete: true,
        expectedIntervalSeconds: 60,
        missingTimes: [],
        duplicateTimes: [],
        outOfOrderTimes: [],
        sourceMismatch: false,
        notes: []
      }
    }
  ],
  tradingViewReference: {
    status: "unavailable",
    provider: null,
    exportedAt: null,
    snapshots: [],
    currentBarRevisions: [],
    notes: ["Awaiting TradingView export"]
  }
};

const pending = runKioseffParityFixture(base);
assert.equal(pending.status, "pending-reference");
assert.equal(pending.divergence?.kind, "fixture-incompleteness");
assert.equal(pending.actualHashes.length, 1);

const allInputs = structuredClone(base);
allInputs.inputs.values = {
  "X-ray": false,
  "Set Color Intensity by Stop Cluster Size": true,
  "Stop Cluster Buys": 7,
  "Stop Cluster Sells": 8,
  "Old Stop Cluster Sells": 9,
  "Old Stop Clusters Buys": 10,
  "Lower Timeframe Vol. Data": "3",
  "Cluster Color": "#010203",
  "Old Cluster Color": "#040506",
  "Time-Scaled Volatility TF": "15",
  "Strong Cluster Color": "#070809",
  "Weak Cluster Color": "#0a0b0c",
  "Show Historical Triggers": true,
  "Show Active Cluster Size": true,
  "Force Find Typical Move (Less Similar)": true,
  "Show Cluster Ratio Meter": false
};
const mapped = settingsFromKioseffFixture(allInputs);
assert.equal(mapped.absorbtion.showXRay, false);
assert.equal(mapped.absorbtion.intensityBySize, true);
assert.equal(mapped.absorbtion.stopClusterBuys, 7);
assert.equal(mapped.absorbtion.stopClusterSells, 8);
assert.equal(mapped.absorbtion.oldStopClusterSells, 9);
assert.equal(mapped.absorbtion.oldStopClusterBuys, 10);
assert.equal(mapped.absorbtion.lowerTimeframe, "3");
assert.equal(mapped.absorbtion.clusterColor, "#010203");
assert.equal(mapped.absorbtion.oldClusterColor, "#040506");
assert.equal(mapped.volatilityAtEntry.timeScaledVolatilityTimeframe, "15");
assert.equal(mapped.volatilityAtEntry.strongClusterColor, "#070809");
assert.equal(mapped.volatilityAtEntry.weakClusterColor, "#0a0b0c");
assert.equal(mapped.volatilityAtEntry.showHistoricalTriggers, true);
assert.equal(mapped.volatilityAtEntry.showActiveClusterSize, true);
assert.equal(mapped.forceTypicalMove, true);
assert.equal(mapped.showClusterRatioMeter, false);

const rejected = structuredClone(base);
rejected.id = "quality-rejected";
rejected.bars[0]!.quality.complete = false;
rejected.bars[0]!.quality.missingTimes = [60];
const rejectedReport = runKioseffParityFixture(rejected);
assert.equal(rejectedReport.status, "fail");
assert.equal(rejectedReport.divergence?.kind, "source-quality-rejection");

console.log("Kioseff first-divergence parity harness tests passed; golden certification pending.");
