import type {
  ExchangeId,
  MarketKind,
  SymbolMetadata,
  Timeframe
} from "../../../market-data/types";
import type { KioseffSnapshot } from "../core/canonical.ts";
import { canonicalSnapshotHash } from "../core/canonical.ts";
import { KioseffParityEngine } from "../core/parityEngine.ts";
import {
  KIOSEFF_DEFAULT_SETTINGS,
  type KioseffSettingsV1
} from "../core/settings.ts";
import type {
  IntrabarQualityReport,
  KioseffChartBarInput,
  NormalizedCandle
} from "../data/types.ts";
import type {
  KioseffFixtureCandle,
  KioseffParityFixture
} from "./fixtureTypes.ts";
import { assertKioseffFixtureContract } from "./fixtureTypes.ts";

export type KioseffDivergenceKind =
  | "missing-source-input"
  | "source-quality-rejection"
  | "fixture-incompleteness"
  | "exact-integer-state-divergence"
  | "float-divergence"
  | "rendering-only-divergence";

export type KioseffFloatTolerance = {
  absolute: number;
  relative: number;
};

export const KIOSEFF_FLOAT_TOLERANCE: KioseffFloatTolerance = {
  absolute: 1e-9,
  relative: 1e-9
};

export type KioseffFirstDivergence = {
  kind: KioseffDivergenceKind;
  model: string;
  granularity: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  sourceVersion: string;
  chartBarIndex: number | null;
  chartBarTime: number | null;
  intrabarIndex: number | null;
  intrabarTime: number | null;
  path: string | null;
  expected: unknown;
  actual: unknown;
  expectedHash: string | null;
  actualHash: string | null;
  trace: {
    atr: number | null;
    sma: number | null;
    signedVolume: number | null;
    direction: number | null;
    factor: number | null;
    projectedPrice: number | null;
    tickKey: number | null;
    lowerGridIndex: number | null;
    binarySearchResult: number | null;
    creationRange: [number, number] | null;
    removalRange: [number, number] | null;
    activeBefore: unknown;
    activeAfter: unknown;
    removedBefore: unknown;
    removedAfter: unknown;
    topFive: number[];
    percentile: number | null;
    nearestCandidates: unknown[];
    iqzz: unknown;
    sellCallSite: unknown;
    buyCallSite: unknown;
    committedStateId: number | null;
    provisionalStateId: number | null;
  };
};

export type KioseffParityReport = {
  status: "pass" | "fail" | "pending-reference";
  fixtureId: string;
  comparedBars: number;
  actualHashes: string[];
  divergence: KioseffFirstDivergence | null;
};

function emptyTrace(): KioseffFirstDivergence["trace"] {
  return {
    atr: null,
    sma: null,
    signedVolume: null,
    direction: null,
    factor: null,
    projectedPrice: null,
    tickKey: null,
    lowerGridIndex: null,
    binarySearchResult: null,
    creationRange: null,
    removalRange: null,
    activeBefore: null,
    activeAfter: null,
    removedBefore: null,
    removedAfter: null,
    topFive: [],
    percentile: null,
    nearestCandidates: [],
    iqzz: null,
    sellCallSite: null,
    buyCallSite: null,
    committedStateId: null,
    provisionalStateId: null
  };
}

function isExactNumericPath(path: string) {
  return /(?:Time|time|tickIndex|sourceCount|schemaVersion|blocks|Through)$/.test(path);
}

export type ValueDifference = {
  path: string;
  expected: unknown;
  actual: unknown;
  kind: "exact-integer-state-divergence" | "float-divergence";
};

export function firstCanonicalDifference(
  expected: unknown,
  actual: unknown,
  tolerance = KIOSEFF_FLOAT_TOLERANCE,
  path = "$"
): ValueDifference | null {
  if (Object.is(expected, actual)) return null;
  if (typeof expected === "number" && typeof actual === "number") {
    if (isExactNumericPath(path) || Number.isInteger(expected) && Number.isInteger(actual)) {
      return { path, expected, actual, kind: "exact-integer-state-divergence" };
    }
    const delta = Math.abs(expected - actual);
    const allowed = tolerance.absolute + tolerance.relative * Math.max(Math.abs(expected), Math.abs(actual));
    return delta <= allowed ? null : { path, expected, actual, kind: "float-divergence" };
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      return { path: `${path}.length`, expected, actual, kind: "exact-integer-state-divergence" };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstCanonicalDifference(
        expected[index],
        actual[index],
        tolerance,
        `${path}[${index}]`
      );
      if (difference) return difference;
    }
    return null;
  }
  if (
    expected &&
    actual &&
    typeof expected === "object" &&
    typeof actual === "object"
  ) {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
    for (const key of keys) {
      if (!(key in expectedRecord) || !(key in actualRecord)) {
        return {
          path: `${path}.${key}`,
          expected: expectedRecord[key],
          actual: actualRecord[key],
          kind: "exact-integer-state-divergence"
        };
      }
      const difference = firstCanonicalDifference(
        expectedRecord[key],
        actualRecord[key],
        tolerance,
        `${path}.${key}`
      );
      if (difference) return difference;
    }
    return null;
  }
  return { path, expected, actual, kind: "exact-integer-state-divergence" };
}

function normalizedCandle(
  candle: KioseffFixtureCandle,
  fixture: KioseffParityFixture
): NormalizedCandle {
  return {
    ...candle,
    source: fixture.source,
    sourceRevision: fixture.sourceRevision
  };
}

function barInput(
  fixture: KioseffParityFixture,
  index: number
): KioseffChartBarInput {
  const source = fixture.bars[index]!;
  const quality: IntrabarQualityReport = {
    complete: source.quality.complete,
    partial: !source.chartBarClosed,
    expectedIntervalSeconds: source.quality.expectedIntervalSeconds,
    expectedCount:
      source.quality.missingTimes.length + source.intrabars.length,
    actualCount: source.intrabars.length,
    coverageStart: source.intrabars[0]?.time ?? null,
    coverageEnd: source.intrabars.at(-1)?.time ?? null,
    missingTimes: source.quality.missingTimes,
    duplicateTimes: source.quality.duplicateTimes,
    outOfOrderTimes: source.quality.outOfOrderTimes,
    conflictingTimes: [],
    sourceMismatch: source.quality.sourceMismatch,
    flags: [],
    notes: source.quality.notes
  };
  return {
    chartBar: normalizedCandle(source.chartBar, fixture),
    intrabars: source.intrabars.map((candle) => normalizedCandle(candle, fixture)),
    chartBarClosed: source.chartBarClosed,
    sourceVersion: source.sourceVersion,
    quality
  };
}

export function settingsFromKioseffFixture(
  fixture: KioseffParityFixture
): KioseffSettingsV1 {
  const settings = structuredClone(KIOSEFF_DEFAULT_SETTINGS);
  settings.model =
    fixture.inputs.model === "Absorbtion Extremes"
      ? "absorbtion-extremes"
      : "volatility-at-entry";
  settings.volatilityAtEntry.granularity =
    fixture.inputs.granularity === "Higher (Heavy)" ? "higher" : "lower";
  settings.absorbtion.lowerTimeframe = fixture.lowerTimeframe;
  for (const [key, value] of Object.entries(fixture.inputs.values)) {
    switch (key) {
      case "X-ray":
        if (typeof value === "boolean") settings.absorbtion.showXRay = value;
        break;
      case "Set Color Intensity by Stop Cluster Size":
        if (typeof value === "boolean") settings.absorbtion.intensityBySize = value;
        break;
      case "Stop Cluster Buys":
        if (typeof value === "number") settings.absorbtion.stopClusterBuys = value;
        break;
      case "Stop Cluster Sells":
        if (typeof value === "number") settings.absorbtion.stopClusterSells = value;
        break;
      case "Old Stop Cluster Sells":
        if (typeof value === "number") settings.absorbtion.oldStopClusterSells = value;
        break;
      case "Old Stop Clusters Buys":
        if (typeof value === "number") settings.absorbtion.oldStopClusterBuys = value;
        break;
      case "Lower Timeframe Vol. Data":
        if (typeof value === "string") settings.absorbtion.lowerTimeframe = value;
        break;
      case "Cluster Color":
        if (typeof value === "string") settings.absorbtion.clusterColor = value;
        break;
      case "Old Cluster Color":
        if (typeof value === "string") settings.absorbtion.oldClusterColor = value;
        break;
      case "Time-Scaled Volatility TF":
        if (typeof value === "string") {
          settings.volatilityAtEntry.timeScaledVolatilityTimeframe = value;
        }
        break;
      case "Strong Cluster Color":
        if (typeof value === "string") settings.volatilityAtEntry.strongClusterColor = value;
        break;
      case "Weak Cluster Color":
        if (typeof value === "string") settings.volatilityAtEntry.weakClusterColor = value;
        break;
      case "Show Historical Triggers":
        if (typeof value === "boolean") {
          settings.volatilityAtEntry.showHistoricalTriggers = value;
        }
        break;
      case "Show Active Cluster Size":
        if (typeof value === "boolean") {
          settings.volatilityAtEntry.showActiveClusterSize = value;
        }
        break;
      case "Force Find Typical Move (Less Similar)":
        if (typeof value === "boolean") settings.forceTypicalMove = value;
        break;
      case "Show Cluster Ratio Meter":
        if (typeof value === "boolean") settings.showClusterRatioMeter = value;
        break;
    }
  }
  return settings;
}

function metadata(fixture: KioseffParityFixture): SymbolMetadata {
  return {
    exchange: fixture.venue as ExchangeId,
    rawSymbol: fixture.rawSymbol,
    normalizedSymbol: fixture.normalizedSymbol,
    assetClass: fixture.assetClass,
    marketKind: fixture.marketKind as MarketKind,
    tickSize: fixture.tickSize,
    timezone: fixture.timezone,
    sessionPolicy: fixture.sessionPolicy,
    source: fixture.source,
    sourceRevision: fixture.sourceRevision
  };
}

function fixtureDivergence(
  fixture: KioseffParityFixture,
  kind: KioseffDivergenceKind,
  expected: unknown,
  actual: unknown,
  barIndex: number | null = null,
  path: string | null = null
): KioseffFirstDivergence {
  const snapshotHash = (candidate: unknown) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !Array.isArray((candidate as Partial<KioseffSnapshot>).activeClusters)
    ) {
      return null;
    }
    return canonicalSnapshotHash(candidate as KioseffSnapshot);
  };
  return {
    kind,
    model: fixture.inputs.model,
    granularity: fixture.inputs.granularity,
    symbol: fixture.rawSymbol,
    exchange: fixture.venue,
    timeframe: fixture.chartTimeframe,
    sourceVersion: fixture.sourceRevision,
    chartBarIndex: barIndex,
    chartBarTime: barIndex === null ? null : fixture.bars[barIndex]?.chartBar.time ?? null,
    intrabarIndex: null,
    intrabarTime: null,
    path,
    expected,
    actual,
    expectedHash: snapshotHash(expected),
    actualHash: snapshotHash(actual),
    trace: emptyTrace()
  };
}

export function runKioseffParityFixture(value: unknown): KioseffParityReport {
  assertKioseffFixtureContract(value);
  const fixture = value;
  if (!fixture.bars.length) {
    return {
      status: "fail",
      fixtureId: fixture.id,
      comparedBars: 0,
      actualHashes: [],
      divergence: fixtureDivergence(fixture, "missing-source-input", "at least one bar", [])
    };
  }
  const rejectedIndex = fixture.bars.findIndex(
    (bar) =>
      !bar.quality.complete ||
      bar.quality.sourceMismatch ||
      bar.quality.missingTimes.length > 0 ||
      bar.quality.duplicateTimes.length > 0 ||
      bar.quality.outOfOrderTimes.length > 0
  );
  if (rejectedIndex >= 0) {
    return {
      status: "fail",
      fixtureId: fixture.id,
      comparedBars: 0,
      actualHashes: [],
      divergence: fixtureDivergence(
        fixture,
        "source-quality-rejection",
        "complete ordered same-source intrabars",
        fixture.bars[rejectedIndex]!.quality,
        rejectedIndex
      )
    };
  }
  const engine = new KioseffParityEngine({
    metadata: metadata(fixture),
    timeframe: fixture.chartTimeframe as Timeframe,
    sourceVersion: fixture.sourceRevision,
    settings: settingsFromKioseffFixture(fixture),
    diagnostics: true
  });
  const actual: KioseffSnapshot[] = [];
  for (let index = 0; index < fixture.bars.length; index += 1) {
    actual.push(engine.processBar(barInput(fixture, index)));
  }
  const hashes = actual.map(canonicalSnapshotHash);
  if (
    fixture.tradingViewReference.status !== "available" ||
    fixture.tradingViewReference.snapshots.length === 0
  ) {
    return {
      status: "pending-reference",
      fixtureId: fixture.id,
      comparedBars: 0,
      actualHashes: hashes,
      divergence: fixtureDivergence(
        fixture,
        "fixture-incompleteness",
        "TradingView snapshots",
        fixture.tradingViewReference
      )
    };
  }
  if (fixture.tradingViewReference.snapshots.length !== actual.length) {
    return {
      status: "fail",
      fixtureId: fixture.id,
      comparedBars: 0,
      actualHashes: hashes,
      divergence: fixtureDivergence(
        fixture,
        "fixture-incompleteness",
        actual.length,
        fixture.tradingViewReference.snapshots.length
      )
    };
  }
  for (let index = 0; index < actual.length; index += 1) {
    const expected = fixture.tradingViewReference.snapshots[index] as KioseffSnapshot;
    const difference = firstCanonicalDifference(expected, actual[index]);
    if (difference) {
      return {
        status: "fail",
        fixtureId: fixture.id,
        comparedBars: index,
        actualHashes: hashes,
        divergence: fixtureDivergence(
          fixture,
          difference.kind,
          expected,
          actual[index],
          index,
          difference.path
        )
      };
    }
  }
  return {
    status: "pass",
    fixtureId: fixture.id,
    comparedBars: actual.length,
    actualHashes: hashes,
    divergence: null
  };
}
