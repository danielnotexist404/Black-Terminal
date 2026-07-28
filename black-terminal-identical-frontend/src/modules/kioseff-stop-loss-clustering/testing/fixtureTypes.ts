export type KioseffFixtureModel = "Absorbtion Extremes" | "Volatility-At-Entry";
export type KioseffFixtureGranularity = "Lower" | "Higher (Heavy)";
export type KioseffFixtureCertification = "structural" | "provisional" | "tradingview-certified";

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
  if (!fixture.tradingViewReference) throw new Error("fixture TradingView reference status is required");
  if (
    fixture.certification === "tradingview-certified" &&
    (fixture.tradingViewReference.status !== "available" || fixture.tradingViewReference.snapshots.length === 0)
  ) {
    throw new Error("certified fixtures require non-empty TradingView snapshots");
  }
}

