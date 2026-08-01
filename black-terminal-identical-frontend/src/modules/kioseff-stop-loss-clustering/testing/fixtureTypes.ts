import type { KioseffSettingsV1 } from "../core/settings.ts";

export type KioseffFixtureModel = "Absorbtion Extremes" | "Volatility-At-Entry";
export type KioseffFixtureGranularity = "Lower" | "Higher (Heavy)";
export type KioseffFixtureCertification = "structural" | "provisional" | "tradingview-certified";

export const KIOSEFF_PINE_INPUT_VALUE_KEYS = [
  "X-ray",
  "Set Color Intensity by Stop Cluster Size",
  "Stop Cluster Buys",
  "Stop Cluster Sells",
  "Old Stop Cluster Sells",
  "Old Stop Clusters Buys",
  "Lower Timeframe Vol. Data",
  "Cluster Color",
  "Old Cluster Color",
  "Time-Scaled Volatility TF",
  "Strong Cluster Color",
  "Weak Cluster Color",
  "Show Historical Triggers",
  "Show Active Cluster Size",
  "Force Find Typical Move (Less Similar)",
  "Show Cluster Ratio Meter"
] as const;

export type KioseffFixtureCandle = {
  originalTime: string | number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type KioseffFixtureQuality = {
  complete: boolean;
  expectedIntervalSeconds: number;
  missingTimes: number[];
  duplicateTimes: number[];
  outOfOrderTimes: number[];
  sourceMismatch: boolean;
  notes: string[];
};

export type KioseffFixtureChartBar = {
  chartBar: KioseffFixtureCandle;
  intrabars: KioseffFixtureCandle[];
  chartBarClosed: boolean;
  sourceVersion: string;
  quality: KioseffFixtureQuality;
};

export type KioseffFixtureReference = {
  status: "available" | "unavailable";
  provider: "TradingView" | null;
  exportedAt: string | null;
  snapshots: unknown[];
  currentBarRevisions: unknown[];
  notes: string[];
};

export type KioseffParityFixture = {
  schemaVersion: 1;
  id: string;
  certification: KioseffFixtureCertification;
  venue: string;
  rawSymbol: string;
  normalizedSymbol: string;
  assetClass: "crypto" | "forex" | "equity" | "futures" | "other";
  marketKind: string;
  tickSize: string;
  chartTimeframe: string;
  lowerTimeframe: string;
  timezone: string;
  sessionPolicy: string;
  source: string;
  sourceRevision: string;
  provenance: {
    historicalVenue: string;
    realtimeVenue: string;
    transport: "fixture" | "browser" | "tauri";
    normalizedBy: string;
  };
  warmup: {
    start: number;
    end: number;
    requestedChartBars: number;
    loadedChartBars: number;
  };
  inputs: {
    model: KioseffFixtureModel;
    granularity: KioseffFixtureGranularity;
    values: Record<string, boolean | number | string>;
  };
  qualityFlags: string[];
  bars: KioseffFixtureChartBar[];
  tradingViewReference: KioseffFixtureReference;
};

/** Canonical, ungrouped market-data contract used to create golden fixtures. */
export type KioseffParityDataset = {
  symbol: string;
  venue: string;
  marketKind: string;
  chartTimeframe: string;
  lowerTimeframe: string;
  chartBars: KioseffFixtureCandle[];
  lowerTimeframeBars: KioseffFixtureCandle[];
  terminalTimestamp: number;
  tickSize: string;
  settings: KioseffSettingsV1;
};

export function assertKioseffParityDataset(
  dataset: KioseffParityDataset
) {
  if (!dataset.chartBars.length) throw new Error("parity dataset requires chart bars");
  if (!dataset.lowerTimeframeBars.length) {
    throw new Error("parity dataset requires lower-timeframe bars");
  }
  if (!Number.isFinite(dataset.terminalTimestamp)) {
    throw new Error("parity dataset terminal timestamp must be finite");
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(dataset.tickSize)) {
    throw new Error("parity dataset tick size must be an authoritative decimal string");
  }
  const assertChronological = (
    name: string,
    bars: readonly KioseffFixtureCandle[]
  ) => {
    const times = new Set<number>();
    for (let index = 0; index < bars.length; index += 1) {
      const time = bars[index]!.time;
      if (!Number.isInteger(time) || time > 10_000_000_000) {
        throw new Error(`${name} timestamps must be integer Unix seconds`);
      }
      if (times.has(time)) throw new Error(`${name} contains duplicate timestamp ${time}`);
      if (index > 0 && time <= bars[index - 1]!.time) {
        throw new Error(`${name} must be strictly chronological`);
      }
      if (time > dataset.terminalTimestamp) {
        throw new Error(`${name} extends beyond the terminal timestamp`);
      }
      times.add(time);
    }
  };
  assertChronological("chart bars", dataset.chartBars);
  assertChronological("lower-timeframe bars", dataset.lowerTimeframeBars);
}

export function assertKioseffFixtureContract(value: unknown): asserts value is KioseffParityFixture {
  if (!value || typeof value !== "object") throw new Error("fixture must be an object");
  const fixture = value as Partial<KioseffParityFixture>;
  if (fixture.schemaVersion !== 1) throw new Error("fixture schemaVersion must be 1");
  for (const key of [
    "id",
    "certification",
    "venue",
    "rawSymbol",
    "normalizedSymbol",
    "assetClass",
    "marketKind",
    "tickSize",
    "chartTimeframe",
    "lowerTimeframe",
    "timezone",
    "sessionPolicy",
    "source",
    "sourceRevision"
  ] as const) {
    if (typeof fixture[key] !== "string" || fixture[key].length === 0) {
      throw new Error(`fixture ${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(fixture.bars)) throw new Error("fixture bars must be an array");
  if (
    !fixture.inputs ||
    typeof fixture.inputs !== "object" ||
    !fixture.inputs.values ||
    typeof fixture.inputs.values !== "object"
  ) {
    throw new Error("fixture Pine inputs are required");
  }
  if (!fixture.tradingViewReference) throw new Error("fixture TradingView reference status is required");
  if (
    fixture.certification === "tradingview-certified" &&
    (fixture.tradingViewReference.status !== "available" || fixture.tradingViewReference.snapshots.length === 0)
  ) {
    throw new Error("certified fixtures require non-empty TradingView snapshots");
  }
  if (
    fixture.certification === "tradingview-certified" ||
    fixture.tradingViewReference.status === "available"
  ) {
    for (const key of KIOSEFF_PINE_INPUT_VALUE_KEYS) {
      if (!(key in fixture.inputs.values)) {
        throw new Error(`reference fixture is missing Pine input ${key}`);
      }
    }
  }
}
