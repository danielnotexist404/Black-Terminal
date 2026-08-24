export type InstitutionalFlowFund = {
  ticker: string;
  manager: string;
  name: string;
  classification: "SPOT_CRYPTO_ETP";
  lastPrice: number;
  percentChange: number;
  volume: number;
  avgVolume20d: number;
  relativeVolume: number;
  aumUsd: number;
  turnoverUsd: number;
  signedTurnoverUsd: number;
  pressureScore: number;
  bidPrice: number;
  askPrice: number;
  sourceTimestamp: string;
  isRealTime: boolean;
  sourceUrl: string;
};

export type InstitutionalFlowPoint = {
  time: number;
  pressure: number;
  signal: number;
};

export type InstitutionalFlowSnapshot = {
  version: 1;
  asset: string;
  state: "live" | "degraded" | "stale" | "unsupported";
  generatedAt: number;
  ageMs: number;
  staleReason?: string;
  reporting: {
    primaryFlowCadence?: string;
    primaryFlowStatus: string;
    reportedNetFlowUsd: number | null;
    livePressureCadence?: string;
    livePressureIsPrimaryFlow: false;
  };
  basket: null | {
    pressureScore: number;
    breadthPct: number;
    positiveFunds: number;
    negativeFunds: number;
    totalFunds: number;
    totalAumUsd: number;
    totalTurnoverUsd: number;
    signedTurnoverUsd: number;
    marketStatus: string;
  };
  funds: InstitutionalFlowFund[];
  oscillator: InstitutionalFlowPoint[];
  disclosures: {
    treasury: Array<{
      company: string;
      symbol: string;
      classification: string;
      cadence: string;
      liveFlowAvailable: false;
      sourceUrl: string;
    }>;
    exclusions: Array<{ manager: string; reason: string; includedInBasket: false }>;
  };
  methodology: Record<string, string | string[]>;
  sourceFailures: number;
};
