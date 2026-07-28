import assert from "node:assert/strict";
import type { SymbolMetadata } from "../src/market-data/types.ts";
import { AbsorbtionExtremesEngine } from "../src/modules/kioseff-stop-loss-clustering/core/absorbtionEngine.ts";
import { canonicalSnapshotHash } from "../src/modules/kioseff-stop-loss-clustering/core/canonical.ts";
import { KIOSEFF_DEFAULT_SETTINGS } from "../src/modules/kioseff-stop-loss-clustering/core/settings.ts";
import { VolatilityAtEntryEngine } from "../src/modules/kioseff-stop-loss-clustering/core/volatilityAtEntryEngine.ts";
import type {
  IntrabarQualityReport,
  KioseffChartBarInput,
  NormalizedCandle
} from "../src/modules/kioseff-stop-loss-clustering/data/types.ts";

const metadata: SymbolMetadata = {
  exchange: "mock",
  rawSymbol: "TESTUSDT",
  normalizedSymbol: "TEST/USDT",
  assetClass: "crypto",
  marketKind: "perpetual",
  tickSize: "0.05",
  timezone: "UTC",
  sessionPolicy: "24x7",
  source: "fixture"
};

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100
): NormalizedCandle {
  return {
    time,
    open,
    high,
    low,
    close,
    volume,
    originalTime: time,
    source: "fixture",
    sourceRevision: "1"
  };
}

function quality(actualCount: number, expectedCount = actualCount): IntrabarQualityReport {
  return {
    complete: actualCount === expectedCount,
    partial: false,
    expectedIntervalSeconds: 60,
    expectedCount,
    actualCount,
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
}

function input(
  chartBar: NormalizedCandle,
  intrabars: NormalizedCandle[],
  closed = true
): KioseffChartBarInput {
  return {
    chartBar,
    intrabars,
    chartBarClosed: closed,
    sourceVersion: "fixture-v1",
    quality: quality(intrabars.length)
  };
}

function intrabarsFor(bar: NormalizedCandle, count = 5) {
  const values: NormalizedCandle[] = [];
  for (let index = 0; index < count; index += 1) {
    const progress = (index + 1) / count;
    const close = bar.open + (bar.close - bar.open) * progress;
    values.push(
      candle(
        bar.time + index * 60,
        index ? values[index - 1]!.close : bar.open,
        Math.max(close, bar.open) + 0.15,
        Math.min(close, bar.open) - 0.15,
        close,
        10 + index
      )
    );
  }
  return values;
}

const baseContext = {
  metadata,
  timeframe: "5m" as const,
  sourceVersion: "fixture-v1",
  settings: structuredClone(KIOSEFF_DEFAULT_SETTINGS),
  diagnostics: true
};

const absorbtion = new AbsorbtionExtremesEngine(baseContext);
for (let index = 0; index < 90; index += 1) {
  const rising = index % 8 < 4;
  const open = 100 + (rising ? index % 4 : 4 - (index % 4)) * 4;
  const close = open + (rising ? 3 : -3);
  const bar = candle(index * 300, open, Math.max(open, close) + 2, Math.min(open, close) - 2, close);
  absorbtion.processBar(input(bar, intrabarsFor(bar)));
}
const absorbtionState = absorbtion.exportState();
assert.ok(absorbtionState.pivotPrices.length > 1, "IQZZ must retain confirmed historical points");
assert.notStrictEqual(absorbtionState.buy, absorbtionState.sell, "buy and sell call sites own state");
const absorbtionHash = canonicalSnapshotHash(absorbtion.snapshot());
const restoredAbsorbtion = new AbsorbtionExtremesEngine(baseContext);
restoredAbsorbtion.importState(absorbtionState);
assert.equal(canonicalSnapshotHash(restoredAbsorbtion.snapshot()), absorbtionHash);

const higherSettings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
higherSettings.model = "volatility-at-entry";
higherSettings.volatilityAtEntry.granularity = "higher";
const higher = new VolatilityAtEntryEngine({ ...baseContext, settings: higherSettings });
for (let index = 0; index < 40; index += 1) {
  const open = 100 + index * 0.02;
  const bar = candle(index * 300, open, open + 0.5, open - 0.5, open + (index % 2 ? -0.1 : 0.1));
  higher.processBar(input(bar, intrabarsFor(bar)));
}
const higherState = higher.exportState();
assert.equal(
  higherState.higher.activeKeys.length,
  new Set(higherState.higher.activeKeys).size,
  "higher tick keys remain unique"
);
assert.deepEqual(
  higherState.higher.activeKeys,
  [...higherState.higher.activeKeys].sort((left, right) => left - right),
  "higher active keys remain sorted"
);
assert.equal(higher.snapshot().granularity, "higher");
const higherRestored = new VolatilityAtEntryEngine({ ...baseContext, settings: higherSettings });
higherRestored.importState(higherState);
assert.equal(
  canonicalSnapshotHash(higherRestored.snapshot()),
  canonicalSnapshotHash(higher.snapshot()),
  "higher state reload is deterministic"
);

const lowerSettings = structuredClone(higherSettings);
lowerSettings.volatilityAtEntry.granularity = "lower";
lowerSettings.volatilityAtEntry.showHistoricalTriggers = true;
const lower = new VolatilityAtEntryEngine({ ...baseContext, settings: lowerSettings });
for (let index = 0; index < 80; index += 1) {
  const open = 100 + Math.sin(index / 5);
  const bar = candle(index * 300, open, open + 0.8, open - 0.8, open + Math.cos(index) * 0.2);
  lower.processBar(input(bar, intrabarsFor(bar)));
}
const frozen = lower.exportState().lower.frozenWidth;
assert.ok(frozen !== null && frozen > 0, "lower width freezes after chart ATR/SMA warm-up");
const volatile = candle(80 * 300, 100, 140, 60, 120, 10_000);
lower.processBar(input(volatile, intrabarsFor(volatile)));
assert.equal(lower.exportState().lower.frozenWidth, frozen, "lower width never recalculates");
assert.equal(
  lower.exportState().lower.levels.length,
  lower.exportState().lower.active.length,
  "lower active cells remain in lockstep"
);
assert.equal(
  lower.exportState().lower.levels.length,
  lower.exportState().lower.removed.length,
  "lower removed cells remain in lockstep"
);

const incomplete = new VolatilityAtEntryEngine({ ...baseContext, settings: higherSettings });
const incompleteBar = candle(0, 100, 101, 99, 100);
const incompleteInput = input(incompleteBar, []);
incompleteInput.quality = quality(0, 5);
const unavailableSnapshot = incomplete.processBar(incompleteInput);
assert.equal(unavailableSnapshot.diagnostics[0]?.code, "incomplete-intrabar-coverage");

console.log("Kioseff Absorbtion and VAE state-machine tests passed.");
