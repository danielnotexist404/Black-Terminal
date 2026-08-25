import type { Candle } from "../../../chart-engine/types.ts";

export const ACVD_INDICATOR_ID = "black-core-acvd" as const;
export const ACVD_MODEL_VERSION = "BC_ACVD_CAUSAL_V1" as const;
export const ACVD_SETTINGS_VERSION = 1 as const;

export type AcvdAuthority = "EXACT_AGGRESSOR_TRADES" | "UNAVAILABLE";
export type AcvdRegime = "UPTREND" | "DOWNTREND" | "ROTATION" | "TRANSITION" | "UNAVAILABLE";
export type AcvdSignalDirection = "long" | "short";
export type AcvdSignalKind = "BC_ACVD_ANY_SIGNAL" | "BC_ACVD_LONG_SIGNAL" | "BC_ACVD_SHORT_SIGNAL";
export type AcvdSmoothingMode = "ADAPTIVE_KAMA" | "EMA" | "RMA";

export type AuthenticFlowBarInput = {
  time: number;
  buyVolume: number;
  sellVolume: number;
  unknownVolume: number;
  buyNotional: number;
  sellNotional: number;
  unknownNotional: number;
  exactTradeCount: number;
  totalTradeCount: number;
  deliveryComplete: boolean;
};

export type AcvdSettings = {
  settingsVersion: typeof ACVD_SETTINGS_VERSION;
  lookback: number;
  realtimeMode: "CONFIRMED_BARS" | "DEVELOPING_PREVIEW";
  deltaBasis: "NOTIONAL" | "QUANTITY";
  smoothingMode: AcvdSmoothingMode;
  smoothingLength: number;
  adaptiveFastLength: number;
  adaptiveSlowLength: number;
  normalizationLookback: number;
  envelopeLookback: number;
  envelopeDeviation: number;
  minimumEnvelopeWidth: number;
  minimumCoveragePercent: number;
  structureLookback: number;
  atrLength: number;
  structureToleranceAtr: number;
  minimumRejectionWickRatio: number;
  confirmationBars: number;
  trendLength: number;
  trendEfficiencyThreshold: number;
  trendProtection: boolean;
  divergenceLookback: number;
  minimumDivergenceScore: number;
  minimumExtremeScore: number;
  minimumReversalImpulse: number;
  minimumSignalConfidence: number;
  maximumChopProbability: number;
  cooldownBars: number;
  resetThreshold: number;
  showRawCvd: boolean;
  showAdaptivePressure: boolean;
  showDynamicEnvelope: boolean;
  showDeltaHistogram: boolean;
  showSignals: boolean;
  showDashboard: boolean;
  showRegimeDiagnostics: boolean;
  bullishColor: string;
  bearishColor: string;
  neutralColor: string;
  envelopeColor: string;
  lineIntensity: number;
  fillIntensity: number;
  lineWidth: number;
};

export type AcvdCalculationInput = {
  candles: Candle[];
  flowBars?: AuthenticFlowBarInput[];
  flowAuthority?: AcvdAuthority;
  flowWarning?: string | null;
  settings: AcvdSettings;
  timeframeSeconds?: number;
  lastBarConfirmed?: boolean;
  marketIdentity?: string;
};

export type AcvdSignal = {
  id: string;
  indicatorId: typeof ACVD_INDICATOR_ID;
  modelVersion: typeof ACVD_MODEL_VERSION;
  direction: AcvdSignalDirection;
  index: number;
  time: number;
  executionEligibleTimestamp: number;
  confidence: number;
  pressure: number;
  deltaRatio: number;
  cumulativeDelta: number;
  structurePrice: number;
  regime: AcvdRegime;
  reasonCodes: string[];
  finalized: true;
  markerTone: "silver-white" | "blood-red";
};

export type AcvdSeries = {
  cumulativeDelta: number[];
  deltaRatio: number[];
  deltaImpulse: number[];
  adaptivePressure: number[];
  center: number[];
  upperEnvelope: number[];
  lowerEnvelope: number[];
  coveragePercent: number[];
  upperStructure: number[];
  lowerStructure: number[];
  atr: number[];
  priceEfficiency: number[];
  chopProbability: number[];
  divergenceScore: number[];
  longConfidence: number[];
  shortConfidence: number[];
  regime: AcvdRegime[];
};

export type AcvdSnapshot = {
  schemaVersion: 1;
  modelVersion: typeof ACVD_MODEL_VERSION;
  indicatorId: typeof ACVD_INDICATOR_ID;
  inputSize: number;
  authority: AcvdAuthority;
  warning: string | null;
  marketIdentity: string;
  settingsHash: string;
  dataHash: string;
  series: AcvdSeries;
  signals: AcvdSignal[];
  latest: {
    state: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNAVAILABLE";
    pressure: number;
    deltaRatio: number;
    cumulativeDelta: number;
    coveragePercent: number;
    regime: AcvdRegime;
    chopProbability: number;
    longConfidence: number;
    shortConfidence: number;
  };
  integrity: {
    causal: true;
    currentBar: "DEVELOPING" | "FINAL";
    closedBarSignalsOnly: true;
    futureBarsConsumed: 0;
    source: AcvdAuthority;
    signalCount: number;
  };
};
